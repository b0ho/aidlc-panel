import * as vscode from "vscode";
import { currentLang, t } from "./i18n";

interface QuestionOption {
  key: string;
  text: string;
}

interface ParsedQuestion {
  answerStart: number;
  answerEnd: number;
  answer: string;
  prompt: string;
  options: QuestionOption[];
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

    return {
      answerStart: marker.answerStart,
      answerEnd: marker.answerEnd,
      answer: marker.answer,
      prompt: (qHeading?.[1] ?? labelled?.[1] ?? questionLine)
        .replace(/^\*\*|\*\*$/g, "")
        .trim(),
      options,
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

  private static html(questions: ParsedQuestion[]): string {
    const esc = QuestionDetailPanel.esc;
    const rows = questions.length === 0
      ? `<p class="empty">${esc(t("No answer fields found in this questions file."))}</p>`
      : questions.map((question, index) => {
          const current = question.answer.trim().toUpperCase();
          const hasOption = question.options.some((option) => option.key === current);
          const options = question.options.map((option) => {
            // Only the option letter is adopted as the answer (data-key), so a
            // selection writes e.g. "A" rather than "A: full text".
            const selected = current === option.key ? " selected" : "";
            return `<button class="option${selected}" data-index="${index}" data-key="${esc(option.key)}"><b>${esc(option.key)}</b><span>${esc(option.text)}</span></button>`;
          }).join("");
          const answered = `<div class="answered" id="answered-${index}"${question.answer ? "" : " hidden"}>${esc(t("Current answer: {0}", question.answer))}</div>`;
          return `<section class="question">
            <div class="number">${esc(t("Question {0}", index + 1))}</div>
            <h2>${esc(question.prompt)}</h2>
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
  .direct-toggle { display: flex; gap: 10px; align-items: center; width: 100%; box-sizing: border-box; margin-top: 12px; min-height: 40px; padding: 10px 12px; text-align: left; color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-panel-border, #8884); border-radius: 7px; } .direct-toggle:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); } .direct-toggle b { color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 2px 7px; border-radius: 4px; } .direct-toggle.selected { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .direct { margin-top: 10px; } textarea { box-sizing: border-box; width: 100%; min-height: 78px; resize: vertical; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); }
  .answered { margin-top: 12px; font-size: 12px; color: var(--vscode-descriptionForeground); }
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
