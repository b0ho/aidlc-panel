import * as vscode from "vscode";
import { currentLang, t } from "./i18n";

interface QuestionOption {
  /** Short badge shown in the option button (a letter like "A", or a number
   *  for label-style options). */
  key: string;
  /** The primary option text shown next to the badge. */
  text: string;
  /** The string written into `[Answer]:` when this option is chosen. Defaults
   *  to `key` (letter formats); for label-style options it is the full label. */
  value?: string;
  /** Optional secondary description shown under the option text. */
  desc?: string;
}

interface ParsedQuestion {
  answerStart: number;
  answerEnd: number;
  answer: string;
  prompt: string;
  options: QuestionOption[];
  /** Reviewable body shown above the options (e.g. a consolidated summary the
   *  user must confirm). Only set for confirmation-style sections. */
  context?: string;
  /** True for confirmation sections (content → "is this correct?") so the card
   *  can be labelled distinctly from a 1:1 question. */
  confirm?: boolean;
}

const ANSWER_LINE = /^([ \t]*(?:[-*+]\s*)?\[Answer\]:[ \t]*)(.*)$/gm;

// AI-DLC question documents commonly use headings such as `## Q1. ...`.
// Keep this separate from the legacy `Question 1:` matcher so that the
// heading itself remains the canonical prompt even when the section contains
// explanatory prose or a final `X. Other` option.
//
// The number may be followed by a parenthetical qualifier before the
// separator — e.g. `## Q5 (Follow-up). ...` or `## Q6 (Revision, ...). ...` —
// so an optional `(...)` group is consumed after the number. Without this the
// qualifier and trailing separator leak into the extracted prompt.
const Q_HEADING = /^\s*#{1,6}\s*Q(?:uestion)?\s*\d*\s*(?:\([^)]*\)\s*)?(?:[.):\-–—]\s*)?(.+?)\s*#*\s*$/i;

const OPTION_LINE = /^\s*(?:[-*+]\s*)?(?:\*\*)?(?:\[([A-Za-z])\]|([A-Za-z])[).:])\s*(?:\*\*)?\s*(.+?)\s*$/;

/** Strip a single pair of surrounding quotes from a scalar value. */
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse the fenced ```question block format some stages emit instead of the
 * `## Q1` + `- A.` layout, e.g.:
 *
 *   ```question
 *   prompt: "…?"
 *   header: …
 *   multiSelect: false
 *   options:
 *     - label: Keep changes
 *       description: …
 *     - label: Discard and pull
 *   ```
 *
 * The chosen option writes its full label into `[Answer]:`. Returns undefined
 * when the section has no such block.
 */
function parseFencedQuestion(
  section: string,
): { prompt?: string; options: QuestionOption[] } | undefined {
  const fence = section.match(/```+\s*question\b[^\n]*\n([\s\S]*?)```/i);
  if (!fence) {
    return undefined;
  }
  const lines = fence[1].split(/\r?\n/);
  let prompt: string | undefined;
  let header: string | undefined;
  const options: QuestionOption[] = [];
  let inOptions = false;
  for (const line of lines) {
    if (/^\s*options\s*:\s*$/i.test(line)) {
      inOptions = true;
      continue;
    }
    const labelMatch = line.match(/^\s*-\s*label\s*:\s*(.+?)\s*$/i);
    if (labelMatch) {
      const label = stripQuotes(labelMatch[1]);
      options.push({
        key: String(options.length + 1),
        text: label,
        value: label,
      });
      inOptions = true;
      continue;
    }
    const descMatch = line.match(/^\s*description\s*:\s*(.+?)\s*$/i);
    if (descMatch && options.length > 0) {
      options[options.length - 1].desc = stripQuotes(descMatch[1]);
      continue;
    }
    if (!inOptions) {
      const promptMatch = line.match(/^\s*prompt\s*:\s*(.+?)\s*$/i);
      if (promptMatch) {
        prompt = stripQuotes(promptMatch[1]);
        continue;
      }
      const headerMatch = line.match(/^\s*header\s*:\s*(.+?)\s*$/i);
      if (headerMatch) {
        header = stripQuotes(headerMatch[1]);
      }
    }
  }
  if (options.length === 0 && !prompt && !header) {
    return undefined;
  }
  return { prompt: prompt ?? header, options };
}

/**
 * Detect a trailing run of plain (non-lettered) bullet choices, e.g. a
 * confirmation section that ends with:
 *   - Looks correct
 *   - Request changes
 * These carry no `A)`/`[A]` key, so the normal option parser misses them.
 * We only take the LAST contiguous run of short, colon-free, non-bold bullets
 * (summary bullets like `- **Q1 → A**: …` are bold + contain a colon, so the
 * backward scan stops before them). Returns [] when there is no such run.
 */
function trailingPlainChoices(lines: string[]): string[] {
  const bullets: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (m) {
      bullets.push(m[1].trim());
    }
  }
  if (bullets.length < 2) {
    return [];
  }
  const choiceLike = (txt: string): boolean =>
    txt.length > 0 &&
    txt.length <= 80 &&
    !txt.includes("**") &&
    !/[:：]/.test(txt) &&
    !/^\[[A-Za-z]\]/.test(txt) &&
    !/^[A-Za-z][).:]/.test(txt);
  const run: string[] = [];
  for (let k = bullets.length - 1; k >= 0; k--) {
    if (choiceLike(bullets[k])) {
      run.unshift(bullets[k]);
    } else {
      break;
    }
  }
  return run.length >= 2 ? run : [];
}

/**
 * Parses the human-turn format emitted by AI-DLC. The answer marker is the
 * source of truth, so each marker becomes one answerable card. Option parsing
 * intentionally accepts the common A) / A. / [A] forms without requiring a
 * new workflow-file format.
 */
function parseQuestions(text: string): ParsedQuestion[] {
  const markers: Array<{ start: number; end: number; answerStart: number; answerEnd: number; answer: string }> = [];
  let match: RegExpExecArray | null;
  ANSWER_LINE.lastIndex = 0;
  while ((match = ANSWER_LINE.exec(text))) {
    const answerStart = match.index + match[1].length;
    markers.push({
      start: match.index,
      end: ANSWER_LINE.lastIndex,
      answerStart,
      answerEnd: ANSWER_LINE.lastIndex,
      answer: match[2].trim(),
    });
  }

  return markers.map((marker, index) => {
    const previousEnd = index === 0 ? 0 : markers[index - 1].end;
    const section = text.slice(previousEnd, marker.start);

    // Fenced ```question blocks carry their own prompt + labelled options and
    // are parsed as a whole; the lettered-heading path below is the fallback
    // for the `## Q1` + `- A.` layout.
    const fenced = parseFencedQuestion(section);
    if (fenced && fenced.options.length > 0) {
      return {
        answerStart: marker.answerStart,
        answerEnd: marker.answerEnd,
        answer: marker.answer,
        prompt: (fenced.prompt ?? t("Question {0}", index + 1)).trim(),
        options: fenced.options,
      };
    }

    const lines = section.split(/\r?\n/);
    const options: QuestionOption[] = [];
    for (const line of lines) {
      const option = line.match(OPTION_LINE);
      const key = option?.[1] ?? option?.[2];
      if (key && option?.[3]) {
        options.push({ key: key.toUpperCase(), text: option[3] });
      }
    }

    const labelled = section.match(
      /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:question|질문)\s*\d*\s*[:.)-]\s*(.+?)(?:\*\*)?\s*(?:\n|$)/i,
    );
    const qHeading = lines.map((line) => line.match(Q_HEADING)).find(Boolean);
    const usefulLines = lines
      .map((line) => line.trim())
      .filter((line) => line && !/^#{1,6}\s*$/.test(line))
      .filter((line) => !OPTION_LINE.test(line));
    const questionLine = usefulLines.find((line) => /[?？]$/.test(line)) ?? usefulLines.at(-1) ?? t("Question {0}", index + 1);

    const prompt = (qHeading?.[1] ?? labelled?.[1] ?? questionLine)
      .replace(/^\*\*|\*\*$/g, "")
      .trim();

    // Confirmation style: content presented for review, ending in plain bullet
    // choices ("- Looks correct" / "- Request changes"). Recognise these as
    // options (when none were lettered) and surface the reviewable body so the
    // user can judge correctness — not just the trailing question.
    let context: string | undefined;
    let confirm = false;
    if (options.length === 0) {
      const choices = trailingPlainChoices(lines);
      const hasQuestion = usefulLines.some((line) => /[?？]$/.test(line));
      if (choices.length >= 2 && hasQuestion) {
        for (const [i, text] of choices.entries()) {
          options.push({ key: String(i + 1), text, value: text });
        }
        confirm = true;
        const chosen = new Set(choices);
        const body = lines
          .filter((line) => {
            const tr = line.trim();
            if (!tr) {
              return true; // keep blanks for readability
            }
            const bullet = tr.match(/^[-*+]\s+(.+?)$/);
            if (bullet && chosen.has(bullet[1].trim())) {
              return false; // option bullet — rendered as a button
            }
            if (tr === prompt || tr.replace(/^#{1,6}\s*/, "") === prompt) {
              return false; // shown as the card prompt
            }
            if (/^#{1,6}\s*$/.test(tr)) {
              return false;
            }
            if (/^([-*_])\1{2,}$/.test(tr)) {
              return false; // horizontal rule
            }
            return true;
          })
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        if (body) {
          context = body;
        }
      }
    }

    return {
      answerStart: marker.answerStart,
      answerEnd: marker.answerEnd,
      answer: marker.answer,
      prompt,
      options,
      context,
      confirm,
    };
  });
}

/** A reusable response panel for an AI-DLC `*-questions.md` file. */
export class QuestionDetailPanel {
  private static panel: vscode.WebviewPanel | undefined;
  private static file: string | undefined;

  static show(file: string): void {
    if (!QuestionDetailPanel.panel) {
      QuestionDetailPanel.panel = vscode.window.createWebviewPanel(
        "aidlcPanelQuestions",
        t("AI-DLC Questions"),
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      QuestionDetailPanel.panel.onDidDispose(() => {
        QuestionDetailPanel.panel = undefined;
        QuestionDetailPanel.file = undefined;
      });
      QuestionDetailPanel.panel.webview.onDidReceiveMessage(
        async (msg: { type?: string; index?: number; value?: string }) => {
          if (msg?.type !== "answer" || typeof msg.index !== "number" || !Number.isInteger(msg.index) || typeof msg.value !== "string") {
            return;
          }
          await QuestionDetailPanel.saveAnswer(msg.index, msg.value);
        },
      );
    }
    QuestionDetailPanel.file = file;
    QuestionDetailPanel.render();
    QuestionDetailPanel.panel.title = `${t("AI-DLC Questions")} · ${file.split(/[\\/]/).pop() ?? file}`;
    QuestionDetailPanel.panel.reveal(vscode.ViewColumn.Active, false);
  }

  private static async saveAnswer(index: number, value: string): Promise<void> {
    const file = QuestionDetailPanel.file;
    if (!file || !value.trim()) {
      return;
    }
    try {
      const uri = vscode.Uri.file(file);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder("utf-8").decode(bytes);
      const question = parseQuestions(text)[index];
      if (!question) {
        throw new Error(t("The question list changed. Reopen it and try again."));
      }
      const edit = new vscode.WorkspaceEdit();
      const document = await vscode.workspace.openTextDocument(uri);
      edit.replace(
        uri,
        new vscode.Range(document.positionAt(question.answerStart), document.positionAt(question.answerEnd)),
        value.trim(),
      );
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error(t("Unable to apply the answer."));
      }
      await document.save();
      // Push a lightweight state update instead of re-rendering the whole
      // webview. A full re-render would reset the direct-input textarea and
      // steal focus mid-typing, which breaks the auto-adopt-on-input flow.
      QuestionDetailPanel.panel?.webview.postMessage({
        type: "saved",
        index,
        answer: value.trim(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(t("Failed to save answer: {0}", message));
    }
  }

  private static render(): void {
    if (!QuestionDetailPanel.panel || !QuestionDetailPanel.file) {
      return;
    }
    void (async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.file(QuestionDetailPanel.file as string),
        );
        if (QuestionDetailPanel.panel) {
          QuestionDetailPanel.panel.webview.html = QuestionDetailPanel.html(
            parseQuestions(new TextDecoder("utf-8").decode(bytes)),
          );
        }
      } catch {
        if (QuestionDetailPanel.panel) {
          QuestionDetailPanel.panel.webview.html = QuestionDetailPanel.html([]);
        }
      }
    })();
  }

  private static esc(value: unknown): string {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Minimal, safe markdown for the confirmation context block: escape, then
   *  render **bold** and drop leading heading hashes. Newlines are preserved
   *  by the block's white-space: pre-wrap, so bullets/lists show as written. */
  private static md(value: string): string {
    return QuestionDetailPanel.esc(value)
      .replace(/^\s*#{1,6}\s+/gm, "")
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  }

  private static html(questions: ParsedQuestion[]): string {
    const esc = QuestionDetailPanel.esc;
    const rows = questions.length === 0
      ? `<p class="empty">${esc(t("No answer fields found in this questions file."))}</p>`
      : questions.map((question, index) => {
          const current = question.answer.trim().toUpperCase();
          const valueOf = (option: QuestionOption): string =>
            (option.value ?? option.key).trim();
          const hasOption = question.options.some(
            (option) => valueOf(option).toUpperCase() === current,
          );
          const options = question.options.map((option) => {
            const value = valueOf(option);
            // The adopted answer (data-key) is the option's value: a letter for
            // `## Q1`/`- A.` formats, or the full label for fenced ```question
            // options — so the written `[Answer]:` matches the source format.
            const selected = value.toUpperCase() === current ? " selected" : "";
            const desc = option.desc
              ? `<small class="desc">${esc(option.desc)}</small>`
              : "";
            return `<button class="option${selected}" data-index="${index}" data-key="${esc(value)}"><b>${esc(option.key)}</b><span>${esc(option.text)}${desc}</span></button>`;
          }).join("");
          const answered = `<div class="answered" id="answered-${index}"${question.answer ? "" : " hidden"}>${esc(t("Current answer: {0}", question.answer))}</div>`;
          const number = question.confirm
            ? t("Confirmation")
            : t("Question {0}", index + 1);
          const context = question.context
            ? `<div class="context">${QuestionDetailPanel.md(question.context)}</div>`
            : "";
          return `<section class="question${question.confirm ? " confirm" : ""}">
            <div class="number">${esc(number)}</div>
            <h2>${esc(question.prompt)}</h2>
            ${context}
            ${options ? `<div class="options">${options}</div>` : `<p class="hint">${esc(t("Enter your response below."))}</p>`}
            <button class="direct-toggle${!hasOption && question.answer ? " selected" : ""}" data-direct="${index}">
              <b>✎</b><span>${esc(t("Direct input"))}</span>
            </button>
            <div class="direct" id="direct-${index}">
              <textarea data-index="${index}" placeholder="${esc(t("Type your answer"))}">${!hasOption ? esc(question.answer) : ""}</textarea>
            </div>
            ${answered}
          </section>`;
        }).join("");
    return `<!doctype html><html lang="${currentLang()}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); max-width: 860px; padding: 20px 24px; }
  h1 { margin: 0 0 6px; font-size: 22px; } .intro, .hint, .empty { color: var(--vscode-descriptionForeground); }
  .question { margin: 18px 0; padding: 18px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 10px; background: var(--vscode-editorWidget-background); }
  .number { color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; } h2 { font-size: 16px; line-height: 1.5; margin: 7px 0 14px; }
  .options { display: flex; flex-direction: column; gap: 8px; }
  button { font: inherit; cursor: pointer; } .option { display: flex; gap: 10px; align-items: flex-start; width: 100%; box-sizing: border-box; min-height: 40px; padding: 10px 12px; text-align: left; color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-panel-border, #8884); border-radius: 7px; }
  .option:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); } .option b { flex: 0 0 auto; color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 2px 7px; border-radius: 4px; }
  .option.selected { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .option span { display: flex; flex-direction: column; gap: 3px; } .option .desc { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
  .direct-toggle { display: flex; gap: 10px; align-items: center; width: 100%; box-sizing: border-box; margin-top: 12px; min-height: 40px; padding: 10px 12px; text-align: left; color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-panel-border, #8884); border-radius: 7px; } .direct-toggle:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); } .direct-toggle b { color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 2px 7px; border-radius: 4px; } .direct-toggle.selected { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .direct { margin-top: 10px; } textarea { box-sizing: border-box; width: 100%; min-height: 78px; resize: vertical; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); }
  .answered { margin-top: 12px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .question.confirm { border-color: var(--vscode-focusBorder, #3b82f6); }
  .question.confirm .number { color: var(--vscode-charts-blue, #3b82f6); }
  .context { white-space: pre-wrap; margin: 0 0 14px; padding: 12px 14px; font-size: 13px; line-height: 1.55; color: var(--vscode-foreground); background: var(--vscode-textBlockQuote-background, #8881); border-left: 3px solid var(--vscode-focusBorder, #3b82f6); border-radius: 6px; }
  .context b { color: var(--vscode-foreground); }
</style></head><body><h1>${esc(t("AI-DLC Questions"))}</h1><p class="intro">${esc(t("Select an option to apply it immediately, or enter a custom response."))}</p>${rows}
<script>
  const vscodeApi = acquireVsCodeApi();
  const ANSWER_PARTS = ${JSON.stringify(t("Current answer: {0}", "\u0000").split("\u0000"))};
  const ANSWER_PREFIX = ANSWER_PARTS[0] || "";
  const ANSWER_SUFFIX = ANSWER_PARTS[1] || "";
  const textareaFor = (index) => document.querySelector('.direct textarea[data-index="' + index + '"]');
  // Pending debounced direct-input saves, keyed by question index, so an option
  // click can cancel a not-yet-flushed keystroke and avoid clobbering the letter.
  const pendingSave = {};

  // Highlight the chosen option (or clear all when key is null, e.g. while the
  // user is typing a custom answer).
  const markSelected = (index, key) => {
    document.querySelectorAll('.option[data-index="' + index + '"]').forEach((b) => {
      b.classList.toggle('selected', key != null && b.dataset.key === key);
    });
  };

  // Option click adopts the letter immediately, even when the direct input
  // still holds text. Any pending direct-input save is cancelled first.
  document.querySelectorAll('.option').forEach((button) => button.addEventListener('click', () => {
    const index = Number(button.dataset.index);
    clearTimeout(pendingSave[index]);
    document.querySelector('.direct-toggle[data-direct="' + index + '"]')?.classList.remove('selected');
    markSelected(index, button.dataset.key);
    vscodeApi.postMessage({ type: 'answer', index, value: button.dataset.key });
  }));

  // Selecting the direct-input area means its current contents are the answer.
  // Keep the textarea visible so the selected mode and its value are obvious.
  document.querySelectorAll('[data-direct]').forEach((button) => button.addEventListener('click', () => {
    const index = Number(button.dataset.direct);
    clearTimeout(pendingSave[index]);
    button.classList.add('selected');
    markSelected(index, null);
    const textarea = textareaFor(index);
    const value = textarea ? textarea.value.trim() : '';
    if (value) { vscodeApi.postMessage({ type: 'answer', index, value }); }
    if (textarea) { textarea.focus(); }
  }));

  // Editing the direct input re-adopts it (debounced). A non-empty value clears
  // any option highlight since the custom answer now wins again.
  document.querySelectorAll('.direct textarea').forEach((textarea) => {
    const index = Number(textarea.dataset.index);
    textarea.addEventListener('input', () => {
      clearTimeout(pendingSave[index]);
      const value = textarea.value.trim();
      if (!value) { return; }
      document.querySelector('.direct-toggle[data-direct="' + index + '"]')?.classList.add('selected');
      markSelected(index, null);
      pendingSave[index] = setTimeout(() => vscodeApi.postMessage({ type: 'answer', index, value }), 450);
    });
  });

  // The host confirms a save with the persisted answer; refresh the "current
  // answer" line without a full re-render so typing state is preserved.
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'saved' || typeof msg.index !== 'number') { return; }
    const line = document.getElementById('answered-' + msg.index);
    if (line) {
      const answer = String(msg.answer);
      line.textContent = ANSWER_PREFIX + answer + ANSWER_SUFFIX;
      line.hidden = !answer.trim();
    }
  });
</script></body></html>`;
  }
}
