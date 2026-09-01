import * as vscode from "vscode";
import { currentLang, t } from "./i18n";
import { findTip, TipItem } from "./tips";

/**
 * Reusable webview panel that renders a help topic (TipItem) in a readable,
 * styled layout — mirrors the stage-detail panel look, with optional inline
 * diagrams and external links.
 */
export class TipDetailPanel {
  private static panel: vscode.WebviewPanel | undefined;
  private static currentTipId: string | undefined;

  /** Re-render the open panel in the current language (used on language change). */
  static refresh(): void {
    if (!TipDetailPanel.panel || !TipDetailPanel.currentTipId) {
      return;
    }
    const tip = findTip(TipDetailPanel.currentTipId);
    if (tip) {
      TipDetailPanel.panel.title = t("Help · {0}", tip.title);
      TipDetailPanel.panel.webview.html = TipDetailPanel.html(tip);
    }
  }

  static show(tip: TipItem): void {
    TipDetailPanel.currentTipId = tip.id;
    if (!TipDetailPanel.panel) {
      TipDetailPanel.panel = vscode.window.createWebviewPanel(
        "aidlcPanelTipDetail",
        t("Help · {0}", tip.title),
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      TipDetailPanel.panel.onDidDispose(() => {
        TipDetailPanel.panel = undefined;
      });
      TipDetailPanel.panel.webview.onDidReceiveMessage(
        (msg: { type?: string; url?: string }) => {
          if (msg?.type === "openUrl" && msg.url) {
            vscode.commands.executeCommand("aidlcPanel.openUrl", msg.url);
          }
        },
      );
    }
    const panel = TipDetailPanel.panel;
    panel.title = t("Help · {0}", tip.title);
    panel.webview.html = TipDetailPanel.html(tip);
    panel.reveal(vscode.ViewColumn.Active, false);
  }

  private static diagram(key: string): string {
    if (key === "lifecycle") {
      const phases = [
        { n: "Phase 0", t: "Initialization", d: t("3 stages · automatic") },
        { n: "Phase 1", t: "Ideation", d: t("Gate 1") },
        { n: "Phase 2", t: "Inception", d: t("Gate 2") },
        { n: "Phase 3", t: "Construction", d: t("Gate 3") },
        { n: "Phase 4", t: "Operation", d: t("Feedback loop") },
      ];
      const boxes = phases
        .map(
          (p, i) =>
            `<div class="flow-box"><span class="fn">${p.n}</span><b>${p.t}</b><span class="fd">${p.d}</span></div>${
              i < phases.length - 1 ? `<span class="arrow">→</span>` : ""
            }`,
        )
        .join("");
      return `<div class="flow">${boxes}</div>`;
    }
    if (key === "intentLoop") {
      const steps = [
        { i: "①", t: t("Intent-1 · Establish the foundation"), d: t("Load architecture and team practices into Space memory") },
        { i: "②", t: t("Intent-2~N · Feature development"), d: t("Accelerated by auto-SKIP of conditional stages") },
        { i: "③", t: t("Urgent · Maintenance"), d: t("Shortest path for bugfix/security-patch") },
      ];
      return `<div class="steps">${steps
        .map(
          (s) =>
            `<div class="step"><span class="si">${s.i}</span><div><b>${s.t}</b><div class="sd">${s.d}</div></div></div>`,
        )
        .join("")}</div>`;
    }
    if (key === "gate") {
      const boxes = [
        { t: t("Run stage"), c: "info" },
        { t: t("Awaiting approval"), c: "warn" },
        { t: t("Approve / Revise / Reject"), c: "ok" },
      ];
      const html = boxes
        .map(
          (b, i) =>
            `<div class="flow-box ${b.c}"><b>${b.t}</b></div>${
              i < boxes.length - 1 ? `<span class="arrow">→</span>` : ""
            }`,
        )
        .join("");
      return `<div class="flow">${html}</div>`;
    }
    return "";
  }

  private static html(tip: TipItem): string {
    const esc = (v: unknown): string =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const sections = tip.sections
      .map(
        (s) =>
          `<div class="card"><h4>${esc(s.heading)}</h4><div class="body">${s.html}</div></div>`,
      )
      .join("");

    const diagram = tip.diagram ? TipDetailPanel.diagram(tip.diagram) : "";

    const links = (tip.links ?? [])
      .map(
        (l) =>
          `<button class="link-btn" data-url="${esc(l.url)}">${esc(l.label)} ↗</button>`,
      )
      .join(" ");

    return `<!doctype html><html lang="${currentLang()}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 22px 26px; max-width: 860px; }
  .eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--vscode-descriptionForeground); }
  h1 { font-size: 23px; margin: 4px 0 6px; }
  .subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 18px; font-size: 13px; }
  .card { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; background: var(--vscode-editorWidget-background); }
  h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
  .body { font-size: 14px; line-height: 1.65; }
  code { background: var(--vscode-textCodeBlock-background, #8882); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  table.cmp { border-collapse: collapse; width: 100%; font-size: 13px; }
  table.cmp th, table.cmp td { border: 1px solid var(--vscode-panel-border, #8884); padding: 6px 10px; text-align: left; }
  table.cmp th { background: var(--vscode-textBlockQuote-background); }
  .diagram { margin: 4px 0 18px; }
  .flow { display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px; }
  .flow-box { flex: 1 1 120px; min-width: 110px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; background: var(--vscode-editorWidget-background); }
  .flow-box .fn { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--vscode-descriptionForeground); }
  .flow-box .fd { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .flow-box.info { border-color: var(--vscode-charts-blue, #3b82f6); }
  .flow-box.warn { border-color: var(--vscode-charts-yellow, #d4a017); }
  .flow-box.ok { border-color: var(--vscode-charts-green, #3fb950); }
  .arrow { align-self: center; color: var(--vscode-descriptionForeground); font-size: 16px; }
  .steps { display: flex; flex-direction: column; gap: 8px; }
  .step { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 10px; padding: 10px 12px; background: var(--vscode-editorWidget-background); }
  .step .si { font-size: 16px; }
  .step .sd { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .links { margin-top: 8px; }
  .link-btn { font-size: 12px; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .link-btn:hover { background: var(--vscode-button-hoverBackground); }
</style></head><body>
  <div class="eyebrow">${esc(t("AI-DLC Help"))}</div>
  <h1>${esc(tip.title)}</h1>
  ${tip.subtitle ? `<p class="subtitle">${esc(tip.subtitle)}</p>` : ""}
  ${diagram ? `<div class="diagram">${diagram}</div>` : ""}
  ${sections}
  ${links ? `<div class="links">${links}</div>` : ""}
  <script>
    const vscodeApi = acquireVsCodeApi();
    document.querySelectorAll('button[data-url]').forEach(function (b) {
      b.addEventListener('click', function () {
        vscodeApi.postMessage({ type: 'openUrl', url: b.getAttribute('data-url') });
      });
    });
  </script>
</body></html>`;
  }
}
