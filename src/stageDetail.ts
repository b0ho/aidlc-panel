import * as vscode from "vscode";
import { AuditEvent } from "./audit";
import { ChangeState } from "./git";
import { currentLang, t } from "./i18n";
import { PHASE_LABEL, statusLabel } from "./labels";
import { isQuestionsArtifact, StageModel } from "./model";
import { fmtCredits } from "./usage";

// Dot color class per audit event for the timeline.
const EVENT_CLS: Record<string, string> = {
  WORKFLOW_STARTED: "info",
  PHASE_STARTED: "info",
  PHASE_COMPLETED: "ok",
  STAGE_STARTED: "info",
  STAGE_AWAITING_APPROVAL: "warn",
  GATE_APPROVED: "ok",
  GATE_REJECTED: "bad",
  STAGE_REVISION_REQUESTED: "warn",
  STAGE_REVISING: "warn",
  STAGE_COMPLETED: "ok",
  SUBAGENT_STARTED: "info",
  SUBAGENT_COMPLETED: "ok",
};

/** Localized label for an audit event (falls back to the raw event name). */
function eventLabel(event: string): string {
  switch (event) {
    case "WORKFLOW_STARTED":
      return t("Workflow started");
    case "PHASE_STARTED":
      return t("Phase started");
    case "PHASE_COMPLETED":
      return t("Phase completed");
    case "STAGE_STARTED":
      return t("Stage started");
    case "STAGE_AWAITING_APPROVAL":
      return t("Awaiting approval");
    case "GATE_APPROVED":
      return t("Gate approved");
    case "GATE_REJECTED":
      return t("Gate rejected");
    case "STAGE_REVISION_REQUESTED":
      return t("Revision requested");
    case "STAGE_REVISING":
      return t("Revising");
    case "STAGE_COMPLETED":
      return t("Stage completed");
    case "SUBAGENT_STARTED":
      return t("Subagent started");
    case "SUBAGENT_COMPLETED":
      return t("Subagent completed");
    default:
      return event;
  }
}

// Curated review guidance per stage. Stages without an entry fall back to a
// produce-derived goal and a generic review checklist. Built lazily so the
// active display language is honoured.
function stageGuide(slug: string): { goal: string; checks: string[] } | undefined {
  const guides: Record<string, { goal: string; checks: string[] }> = {
    "intent-capture": {
      goal: t("Finalize the problem to solve, goals, success criteria, and stakeholders."),
      checks: [
        t("Is the problem definition specific and measurable?"),
        t("Are the success criteria verifiable?"),
        t("Are any stakeholders or scope boundaries missing?"),
      ],
    },
    "requirements-analysis": {
      goal: t("Finalize functional/non-functional requirements, constraints, assumptions, and exclusions."),
      checks: [
        t("Are the requirements consistent with the intent and stories?"),
        t("Are non-functional needs (security, performance, etc.) missing?"),
        t("Are assumptions and exclusions stated?"),
      ],
    },
    "user-stories": {
      goal: t("Turn requirements into user value and verifiable acceptance criteria."),
      checks: [
        t("Does each story have clear user value?"),
        t("Are the acceptance criteria testable?"),
        t("Are dependencies and priorities between stories visible?"),
      ],
    },
    "application-design": {
      goal: t("Finalize components, services, interfaces, and key architectural decisions."),
      checks: [
        t("Are component boundaries and responsibilities clear?"),
        t("Do the interfaces and data flow satisfy the requirements?"),
        t("Are the rationale and alternatives for key decisions recorded?"),
      ],
    },
    "functional-design": {
      goal: t("Finalize the per-unit functional design that code generation references directly."),
      checks: [
        t("Are entities, workflows, and rules consistent with the requirements?"),
        t("Are exceptions, validations, and integration points missing?"),
        t("Is it specific enough to be implementable?"),
      ],
    },
    "nfr-requirements": {
      goal: t("Quantify security, performance, reliability, and scalability targets."),
      checks: [
        t("Are the targets quantified so they can be measured?"),
        t("Do they fit the current unit-of-work scope?"),
        t("Is the verification method defined alongside them?"),
      ],
    },
    "code-generation": {
      goal: t("Implement the approved design as real application code and tests."),
      checks: [
        t("Does the implementation match the design and acceptance criteria?"),
        t("Do the tests cover the key paths and exceptions?"),
        t("Are there arbitrary changes not in the design?"),
      ],
    },
    "build-and-test": {
      goal: t("Run build and tests to verify convergence and quality."),
      checks: [
        t("Do the build and tests actually pass?"),
        t("Are there any remaining failures or warnings?"),
        t("Is coverage sufficient against the acceptance criteria?"),
      ],
    },
  };
  return guides[slug];
}

function genericChecks(): string[] {
  return [
    t("Is it consistent with the previous stages' artifacts and requirements?"),
    t("Are exceptions, edges, and integration points missing?"),
    t("Is it specific enough to use directly in the next stage?"),
    t("Are assumptions, risks, and open decisions stated?"),
  ];
}

export interface StageDetailExtras {
  events: AuditEvent[];
  reviewed: Set<string>; // artifact names marked reviewed
  changeState: (absPath: string) => ChangeState;
  /** Aggregated credit usage attributed to this stage, if any. */
  usage?: { credits: number; turns: number };
}

/**
 * Single reusable webview panel that explains a stage: review guidance (what to
 * check / the goal), artifact review status with change + review badges, and an
 * execution-history timeline built from the audit trail.
 */
export class StageDetailPanel {
  private static panel: vscode.WebviewPanel | undefined;
  private static current: StageModel | undefined;
  private static extrasProvider?: (stage: StageModel) => StageDetailExtras;

  /** Supply the data source for guidance/review/timeline (call once on activate). */
  static setExtrasProvider(fn: (stage: StageModel) => StageDetailExtras): void {
    StageDetailPanel.extrasProvider = fn;
  }

  /** Re-render the open panel (e.g. after a review flag or state change). */
  static refresh(): void {
    if (StageDetailPanel.panel && StageDetailPanel.current) {
      StageDetailPanel.panel.webview.html = StageDetailPanel.html(
        StageDetailPanel.current,
      );
    }
  }

  static show(stage: StageModel): void {
    if (!StageDetailPanel.panel) {
      StageDetailPanel.panel = vscode.window.createWebviewPanel(
        "aidlcPanelStageDetail",
        `AI-DLC · ${stage.name}`,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      StageDetailPanel.panel.onDidDispose(() => {
        StageDetailPanel.panel = undefined;
        StageDetailPanel.current = undefined;
      });
      StageDetailPanel.panel.webview.onDidReceiveMessage(
        (msg: { type?: string; path?: string }) => {
          if (msg?.type === "openArtifact" && msg.path) {
            vscode.commands.executeCommand("aidlcPanel.openArtifact", msg.path);
          } else if (msg?.type === "diffArtifact" && msg.path) {
            vscode.commands.executeCommand("aidlcPanel.diffArtifact", msg.path);
          } else if (msg?.type === "askKiro" && msg.path) {
            vscode.commands.executeCommand("aidlcPanel.askKiroArtifact", {
              aux: { file: msg.path },
            });
          } else if (msg?.type === "toggleReviewed" && msg.path) {
            vscode.commands.executeCommand("aidlcPanel.toggleReviewed", msg.path);
          }
        },
      );
    }
    StageDetailPanel.current = stage;
    const panel = StageDetailPanel.panel;
    panel.title = `AI-DLC · ${stage.number} ${stage.name}`;
    panel.webview.html = StageDetailPanel.html(stage);
    panel.reveal(vscode.ViewColumn.Active, false);
  }

  private static esc(v: unknown): string {
    return String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private static fmtTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return iso;
    }
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  private static timeline(events: AuditEvent[]): string {
    if (events.length === 0) {
      return `<p class="muted">${StageDetailPanel.esc(t("No history recorded yet."))}</p>`;
    }
    const rows = events
      .map((e) => {
        const meta = { label: eventLabel(e.event), cls: EVENT_CLS[e.event] ?? "info" };
        const detail =
          e.fields["User Input"] ??
          e.fields.Message ??
          e.fields.Decision ??
          e.fields.Note ??
          e.fields.Reviewer ??
          "";
        return `<div class="tl-row">
          <span class="dot ${meta.cls}"></span>
          <span class="tl-label">${StageDetailPanel.esc(meta.label)}</span>
          <span class="tl-time">${StageDetailPanel.esc(StageDetailPanel.fmtTime(e.timestamp))}</span>
          ${detail ? `<div class="tl-detail">${StageDetailPanel.esc(detail)}</div>` : ""}
        </div>`;
      })
      .join("");
    return `<div class="timeline">${rows}</div>`;
  }

  private static html(stage: StageModel): string {
    const esc = StageDetailPanel.esc;
    const extras: StageDetailExtras = StageDetailPanel.extrasProvider
      ? StageDetailPanel.extrasProvider(stage)
      : { events: [], reviewed: new Set(), changeState: () => undefined };

    const chips = (items: string[]): string =>
      items.length === 0
        ? `<span class="muted">${esc(t("None"))}</span>`
        : items.map((i) => `<span class="chip">${esc(i)}</span>`).join(" ");

    const agents = [stage.leadAgent, ...stage.supportAgents]
      .filter(Boolean)
      .map((a) => a.replace(/^aidlc-/, "").replace(/-agent$/, ""));

    const guide = stageGuide(stage.slug);
    const goal =
      guide?.goal ??
      (stage.produces.length
        ? t("This stage finalizes {0}.", stage.produces.join(", "))
        : stage.purpose);
    const checks = guide?.checks ?? genericChecks();
    const checkList = checks.map((c) => `<li>${esc(c)}</li>`).join("");

    // Token/credit usage attributed to this stage (best-effort, from Kiro
    // session logs correlated by time). Only shown when we have a figure.
    const usageCard =
      extras.usage && extras.usage.credits > 0
        ? `<div class="card full usage">
             <h4>${esc(t("Token usage (credits)"))}</h4>
             <div class="usage-row">
               <span class="usage-big">⚡ ${esc(fmtCredits(extras.usage.credits))}</span>
               <span class="muted">${esc(t("{0} turns", extras.usage.turns))}</span>
             </div>
             <div class="muted usage-note">${esc(t("Credits consumed while this stage was active, correlated from Kiro session logs."))}</div>
           </div>`
        : "";

    // Review counts cover prose artifacts only — Q&A files are answered, not
    // reviewed, so they are excluded from the ratio.
    const reviewable = stage.artifacts.filter((a) => !isQuestionsArtifact(a.name));
    const total = reviewable.length;
    const reviewed = reviewable.filter((a) => extras.reviewed.has(a.name)).length;
    const reviewPct = total === 0 ? 0 : Math.round((reviewed / total) * 100);

    const artifactRows =
      stage.artifacts.length === 0
        ? `<p class="muted">${esc(t("No artifacts produced yet."))}</p>`
        : stage.artifacts
            .map((a) => {
              const base = a.name.split("/").pop() ?? a.name;
              const isQuestions = isQuestionsArtifact(a.name);
              const isReviewed = extras.reviewed.has(a.name);
              const change = extras.changeState(a.absPath);
              const changeBadge =
                change === "new"
                  ? `<span class="tag new">${esc(t("new"))}</span>`
                  : change === "changed"
                    ? `<span class="tag changed">${esc(t("changed"))}</span>`
                    : "";
              // Q&A files get a Q&A tag and no "Mark reviewed" button — you
              // answer them, you don't review them.
              const tag = isQuestions
                ? `<span class="tag qa">${esc(t("Q&A"))}</span>`
                : `<span class="tag req">${esc(t("Required review"))}</span>`;
              const reviewBtn = isQuestions
                ? ""
                : `<button class="mini ${isReviewed ? "done" : ""}" data-act="review" data-path="${esc(a.absPath)}">${isReviewed ? "✓ " + esc(t("Reviewed")) : esc(t("Mark reviewed"))}</button>`;
              return `<div class="file">
                ${tag}
                ${changeBadge}
                <button class="link" data-act="open" data-path="${esc(a.absPath)}" title="${esc(a.name)}">${esc(base)}</button>
                <span class="spacer"></span>
                ${reviewBtn}
                <button class="mini" data-act="diff" data-path="${esc(a.absPath)}" title="${esc(t("Changes vs git HEAD"))}">${esc(t("View changes"))}</button>
                <button class="ask" data-act="ask" data-path="${esc(a.absPath)}" title="${esc(t("Ask Kiro to review"))}">${esc(t("Kiro review"))}</button>
              </div>`;
            })
            .join("");

    const reviewBar =
      total === 0
        ? ""
        : `<div class="review-head">${esc(t("Review status"))} <b>${reviewed}/${total}</b> · ${reviewPct}%</div>
           <div class="bar"><span style="width:${reviewPct}%"></span></div>`;

    return `<!doctype html><html lang="${currentLang()}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px 24px; max-width: 900px; }
  .eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--vscode-descriptionForeground); }
  h1 { font-size: 22px; margin: 4px 0 10px; }
  .badges { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .badge { font-size: 11px; padding: 2px 10px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge.status-completed { background: var(--vscode-charts-green, #3fb950); color: #08130c; }
  .badge.status-in-progress { background: var(--vscode-charts-blue, #3b82f6); color: #fff; }
  .badge.status-awaiting-approval { background: var(--vscode-charts-yellow, #d4a017); color: #1a1a1a; }
  .badge.status-revising { background: var(--vscode-charts-orange, #e08a1e); color: #1a1a1a; }
  .purpose { font-size: 15px; line-height: 1.6; margin: 12px 0 16px; }
  .condition { font-size: 12px; color: var(--vscode-descriptionForeground); font-style: italic; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .card { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 10px; padding: 14px 16px; background: var(--vscode-editorWidget-background); }
  .card.full { grid-column: 1 / -1; }
  .card.accent { border-color: var(--vscode-focusBorder, #3b82f6); }
  h4 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--vscode-descriptionForeground); }
  .card ul { margin: 0; padding-left: 18px; }
  .card li { font-size: 13px; line-height: 1.6; }
  .goal { font-size: 14px; line-height: 1.6; }
  .chip { display: inline-block; font-size: 12px; padding: 3px 9px; border-radius: 8px; margin: 2px 2px 2px 0; background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-panel-border, #8884); }
  .muted { color: var(--vscode-descriptionForeground); }
  .section-title { margin: 22px 0 8px; font-size: 13px; font-weight: 600; }
  .review-head { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .bar { height: 6px; background: var(--vscode-progressBar-background, #3333); border-radius: 4px; overflow: hidden; margin-bottom: 12px; }
  .bar > span { display: block; height: 100%; background: var(--vscode-charts-green, #3fb950); }
  .file { display: flex; align-items: center; gap: 8px; padding: 5px 0; flex-wrap: wrap; }
  .spacer { flex: 1; }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 7px; }
  .tag.req { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .tag.qa { background: var(--vscode-charts-blue, #3b82f6); color: #fff; }
  .tag.changed { background: var(--vscode-charts-orange, #e08a1e); color: #1a1a1a; }
  .tag.new { background: var(--vscode-charts-green, #3fb950); color: #08130c; }
  button.link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 13px; padding: 0; text-align: left; }
  button.link:hover { text-decoration: underline; }
  button.mini { font-size: 11px; padding: 3px 8px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 5px; cursor: pointer; background: transparent; color: var(--vscode-foreground); }
  button.mini.done { background: var(--vscode-charts-green, #3fb950); color: #08130c; border-color: transparent; }
  button.mini:hover { background: var(--vscode-toolbar-hoverBackground, #8882); }
  button.ask { font-size: 11px; padding: 3px 8px; border: none; border-radius: 5px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.ask:hover { background: var(--vscode-button-hoverBackground); }
  .timeline { border-left: 2px solid var(--vscode-panel-border, #8884); margin-left: 6px; padding-left: 14px; }
  .tl-row { position: relative; padding: 6px 0; font-size: 12px; }
  .dot { position: absolute; left: -21px; top: 9px; width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  .dot.ok { background: var(--vscode-charts-green, #3fb950); }
  .dot.warn { background: var(--vscode-charts-yellow, #d4a017); }
  .dot.bad { background: var(--vscode-charts-red, #f14c4c); }
  .dot.info { background: var(--vscode-charts-blue, #3b82f6); }
  .tl-label { font-weight: 600; }
  .tl-time { color: var(--vscode-descriptionForeground); margin-left: 8px; }
  .tl-detail { color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .card.usage .usage-row { display: flex; align-items: baseline; gap: 12px; }
  .usage-big { font-size: 22px; font-weight: 700; color: var(--vscode-charts-yellow, #d4a017); }
  .usage-note { font-size: 11px; margin-top: 6px; }
</style></head><body>
  <div class="eyebrow">${esc(PHASE_LABEL[stage.phase] ?? stage.phase)} · ${esc(t("Stage"))} ${esc(stage.number)}</div>
  <h1>${esc(stage.name)}</h1>
  <div class="badges">
    <span class="badge status-${esc(stage.status)}">${esc(statusLabel(stage.status))}</span>
    <span class="badge">${esc(stage.slug)}</span>
  </div>
  <p class="purpose">${esc(stage.purpose)}</p>
  ${stage.condition ? `<div class="condition">${esc(stage.condition)}</div>` : ""}

  <div class="grid">
    <div class="card accent"><h4>${esc(t("What to check in this stage"))}</h4><ul>${checkList}</ul></div>
    <div class="card accent"><h4>${esc(t("Goal of this stage"))}</h4><p class="goal">${esc(goal)}</p></div>
  </div>

  ${usageCard ? `<div class="grid" style="margin-top:12px">${usageCard}</div>` : ""}

  <div class="section-title">${esc(t("Artifacts · Review status"))}</div>
  ${reviewBar}
  <div class="card full">${artifactRows}</div>

  <div class="grid" style="margin-top:12px">
    <div class="card"><h4>${esc(t("Assigned agents"))}</h4>${chips(agents)}</div>
    <div class="card"><h4>${esc(t("Inputs (consumes)"))}</h4>${chips(stage.consumes)}</div>
  </div>

  <div class="section-title">${esc(t("Execution history"))}</div>
  ${StageDetailPanel.timeline(extras.events)}

  <script>
    const vscodeApi = acquireVsCodeApi();
    document.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var path = b.getAttribute('data-path');
        var act = b.getAttribute('data-act');
        var type = act === 'open' ? 'openArtifact'
          : act === 'review' ? 'toggleReviewed'
          : act === 'diff' ? 'diffArtifact'
          : 'askKiro';
        vscodeApi.postMessage({ type: type, path: path });
      });
    });
  </script>
</body></html>`;
  }
}
