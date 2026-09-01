import * as vscode from "vscode";
import { currentLang, t } from "./i18n";
import { statusLabel } from "./labels";
import { isQuestionsArtifact, PanelModel, PanelStore } from "./model";
import { ReviewState } from "./review";

export class OverviewViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private titleText: string | undefined;

  constructor(
    private readonly store: PanelStore,
    private readonly review: ReviewState,
  ) {
    store.onDidChange(() => this.render());
    review.onDidChange(() => this.render());
  }

  /** Relabel the view section (used on language change). */
  setTitle(title: string): void {
    this.titleText = title;
    if (this.view) {
      this.view.title = title;
    }
    this.render();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    if (this.titleText) {
      view.title = this.titleText;
    }
    // Purely informational surface — the action buttons now live in the
    // Actions view, so this webview needs no scripting.
    view.webview.options = { enableScripts: false };
    this.render();
  }

  private render(): void {
    if (this.view) {
      this.view.webview.html = this.html(this.store.model);
    }
  }

  private html(model: PanelModel | undefined): string {
    const esc = (v: unknown): string =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    let body: string;
    if (!model) {
      body = `<p class="muted">${esc(t("Loading…"))}</p>`;
    } else if (!model.ok) {
      body = `<p class="muted">${esc(model.message ?? t("Unable to load state."))}</p>`;
    } else {
      const o = model.overall ?? { completed: 0, total: 0, remaining: 0, percent: 0 };
      const currentStatus = (model.stages ?? []).find(
        (s) => s.slug === model.currentStage,
      )?.status;
      const statusChip = currentStatus
        ? `<span class="chip ${currentStatus}">${esc(statusLabel(currentStatus))}</span>`
        : "";
      const phaseChips = (model.phases ?? [])
        .map(
          (p) =>
            `<div class="phase"><span>${esc(p.label)}</span><b>${p.total === 0 ? "—" : p.percent + "%"}</b></div>`,
        )
        .join("");
      const rc = this.review.counts();
      const reviewPct =
        rc.total === 0 ? 0 : Math.round((rc.reviewed / rc.total) * 100);
      const reviewBlock =
        rc.total === 0
          ? ""
          : `<div class="card">
              <div class="card-title">${esc(t("Artifact review status"))}</div>
              <div class="bar" title="${rc.reviewed}/${rc.total}"><span class="rev" style="width:${reviewPct}%"></span></div>
              <div class="bar-label">${esc(t("{0}% · {1}/{2} reviewed", reviewPct, rc.reviewed, rc.total))}</div>
            </div>`;

      // Genuinely actionable "pending review" set: artifacts produced but not
      // yet marked reviewed. This replaces the engine's "Pending Artifacts"
      // resume field, which the engine never writes (it always reads "none"),
      // so the old card was vestigial. Derived from the same ReviewState the
      // Artifacts view uses, so the two surfaces always agree.
      const unreviewed: string[] = [];
      for (const stage of model.stages ?? []) {
        for (const a of stage.artifacts) {
          // Q&A files are answered, not reviewed — never "pending review".
          if (isQuestionsArtifact(a.name)) {
            continue;
          }
          if (!this.review.isReviewed(a.name)) {
            unreviewed.push(a.name.split("/").pop() ?? a.name);
          }
        }
      }
      const pendingTitle = esc(t("Artifacts pending review"));
      const pendingReviewBlock =
        rc.total === 0
          ? `<div class="card">
              <div class="card-title">${pendingTitle}</div>
              <div class="card-body muted">${esc(t("No artifacts produced yet."))}</div>
            </div>`
          : unreviewed.length === 0
            ? `<div class="card">
              <div class="card-title">${pendingTitle}</div>
              <div class="card-body muted">${esc(t("All artifacts reviewed."))}</div>
            </div>`
            : `<div class="card">
              <div class="card-title">${pendingTitle} (${unreviewed.length})</div>
              <div class="card-body">${unreviewed.slice(0, 6).map(esc).join("<br>")}</div>
              ${unreviewed.length > 6 ? `<div class="sub">${esc(t("+{0} more", unreviewed.length - 6))}</div>` : ""}
            </div>`;
      body = `
        <div class="intent">
          <div class="intent-name">${esc(model.intentSlug ?? model.intent)}</div>
          <div class="meta">${esc((model.scope || "").toUpperCase())} · ${esc(model.lifecyclePhase)}</div>
        </div>

        <div class="bar" title="${o.completed}/${o.total}">
          <span style="width:${o.percent}%"></span>
        </div>
        <div class="bar-label">${esc(t("{0}% · {1}/{2} done · {3} left", o.percent, o.completed, o.total, o.remaining))}</div>

        <div class="card next">
          <div class="card-title">${esc(t("Next up"))} ${statusChip}</div>
          <div class="card-body">${esc(model.nextAction)}</div>
          <div class="sub">${esc(t("Current"))}: <code>${esc(model.currentStage)}</code> → ${esc(t("Next"))}: <code>${esc(model.nextStage || "-")}</code></div>
        </div>

        ${reviewBlock}

        ${pendingReviewBlock}

        <div class="phases">${phaseChips}</div>
      `;
    }

    return `<!doctype html><html lang="${currentLang()}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 8px 10px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .intent-name { font-weight: 600; font-size: 13px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; letter-spacing: .3px; }
  .bar { height: 6px; background: var(--vscode-progressBar-background, #3333); border-radius: 4px; overflow: hidden; margin: 10px 0 4px; }
  .bar > span { display: block; height: 100%; background: var(--vscode-charts-green, #3fb950); }
  .bar > span.rev { background: var(--vscode-charts-blue, #3b82f6); }
  .bar-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .card { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; padding: 8px 10px; margin-top: 10px; }
  .card.next { background: var(--vscode-editorWidget-background); }
  .card-title { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .card-body { font-size: 13px; }
  .sub { margin-top: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .chip { font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-left: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip.awaiting-approval { background: var(--vscode-charts-yellow, #d4a017); color: #1a1a1a; }
  .chip.in-progress { background: var(--vscode-charts-blue, #3b82f6); color: #fff; }
  .chip.revising { background: var(--vscode-charts-orange, #e08a1e); color: #1a1a1a; }
  .phases { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .phase { flex: 1 1 40%; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; padding: 6px 8px; display: flex; justify-content: space-between; font-size: 11px; }
</style></head><body>
  ${body}
</body></html>`;
  }
}
