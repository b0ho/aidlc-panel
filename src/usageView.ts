import * as vscode from "vscode";
import { t } from "./i18n";
import { PanelStore, StageModel } from "./model";
import { fmtCredits, SessionUsage, TurnUsage, UsageStore } from "./usage";

/**
 * "Token usage" tree view (aidlcPanelUsage).
 *
 * A dedicated workspace view that breaks Kiro credit consumption down per
 * session and, within each session, per AI-DLC intent → stage → prompt turn.
 * When an audit trail lets us attribute turns to the intent/stage active at
 * their time, each session groups its turns under that intent and stage — so
 * the same data reads both "by conversation" and "by workflow intent/stage".
 * Turns with no attributable audit fall back to a flat session → turn list.
 */

type UsageNode =
  | { kind: "message"; text: string }
  | { kind: "summary" }
  | { kind: "workspaceGroup"; workspace: string; sessions: SessionUsage[] }
  | { kind: "session"; session: SessionUsage }
  | { kind: "intentGroup"; session: SessionUsage; intent: string; turns: TurnUsage[] }
  | { kind: "stageGroup"; slug: string; turns: TurnUsage[] }
  | { kind: "turn"; turn: TurnUsage };

const UNASSIGNED = "\u0000unassigned";

/** Sum credits over a set of turns. */
function sumCredits(turns: TurnUsage[]): number {
  return turns.reduce((s, tn) => s + tn.credits, 0);
}

/** Group turns by a key (first-seen order preserved). */
function groupBy(
  turns: TurnUsage[],
  keyOf: (t: TurnUsage) => string,
): { key: string; turns: TurnUsage[] }[] {
  const order: string[] = [];
  const map = new Map<string, TurnUsage[]>();
  for (const turn of turns) {
    const k = keyOf(turn);
    if (!map.has(k)) {
      map.set(k, []);
      order.push(k);
    }
    map.get(k)!.push(turn);
  }
  return order.map((key) => ({ key, turns: map.get(key)! }));
}

export class UsageProvider implements vscode.TreeDataProvider<UsageNode> {
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._emitter.event;

  constructor(
    private readonly usage: UsageStore,
    private readonly store: PanelStore,
  ) {
    usage.onDidChange(() => this._emitter.fire());
    // Stage display names come from the model; re-render when it reloads.
    store.onDidChange(() => this._emitter.fire());
  }

  /** Resolve a stage slug to a "number name" display label via the model. */
  private stageLabel(slug: string): string {
    if (slug === UNASSIGNED) {
      return t("Unassigned");
    }
    const stage = (this.store.model?.stages ?? []).find(
      (s: StageModel) => s.slug === slug,
    );
    return stage ? `${stage.number} ${stage.name}` : slug;
  }

  private intentLabel(intent: string): string {
    return intent === UNASSIGNED ? t("Unassigned") : intent;
  }

  private fmtElapsed(ms: number): string {
    if (!ms || ms < 0) {
      return "";
    }
    const s = ms / 1000;
    return s >= 60 ? `${Math.round(s / 60)}m` : `${s.toFixed(0)}s`;
  }

  private fmtWhen(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return "";
    }
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  getTreeItem(node: UsageNode): vscode.TreeItem {
    if (node.kind === "message") {
      return new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    }

    if (node.kind === "workspaceGroup") {
      const credits = node.sessions.reduce((s, x) => s + x.totalCredits, 0);
      const turns = node.sessions.reduce((s, x) => s + x.turns.length, 0);
      const item = new vscode.TreeItem(
        node.workspace ? node.workspace.split("/").pop() || node.workspace : t("Unknown"),
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `⚡ ${fmtCredits(credits)} · ${t("{0} turns", turns)}`;
      item.iconPath = new vscode.ThemeIcon("folder");
      item.tooltip = new vscode.MarkdownString(
        `**${node.workspace}**\n\n${t("Credits: {0}", fmtCredits(credits))} · ${t("{0} sessions · {1} turns", node.sessions.length, turns)}`,
      );
      item.contextValue = "usage-workspace";
      return item;
    }

    if (node.kind === "summary") {
      const u = this.usage.usage;
      const total = u ? fmtCredits(u.totalCredits) : "0";
      const scopeTag = u?.scope === "global" ? t("all workspaces") : t("this workspace");
      const periodTag = u?.period ? u.period : t("all time");
      const item = new vscode.TreeItem(
        t("Total: {0} credits", total),
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = u
        ? `${periodTag} · ${scopeTag} · ${t("{0} sessions · {1} turns", u.sessions.length, u.turnCount)}`
        : "";
      item.iconPath = new vscode.ThemeIcon("graph");
      // Per-intent breakdown in the tooltip so the whole project's spend by
      // intent is visible at a glance even though the tree is session-first.
      const lines = [
        `**${t("Token usage (credits)")}**`,
        "",
        t(
          "Kiro credit consumption for this workspace (read from ~/.kiro/sessions).",
        ),
      ];
      if (u && u.byIntent.size > 0) {
        let attributed = 0;
        const rows = [...u.byIntent.entries()].sort(
          (a, b) => b[1].credits - a[1].credits,
        );
        for (const [, agg] of rows) {
          attributed += agg.turns;
        }
        lines.push("", `**${t("By intent")}**`);
        for (const [intent, agg] of rows) {
          const active = intent === u.activeIntent ? " ●" : "";
          lines.push(
            `- ${intent}${active}: ⚡ ${fmtCredits(agg.credits)} · ${t("{0} turns", agg.turns)}`,
          );
        }
        // Be transparent: intent/stage attribution is a time-based estimate,
        // and only turns whose time falls inside an intent's audit window are
        // counted. Per-session / per-turn figures below are exact.
        lines.push(
          "",
          t(
            "Intent/stage split is a time-based estimate ({0} of {1} turns attributed). Per-session and per-turn credits are exact.",
            attributed,
            u.turnCount,
          ),
        );
      }
      item.tooltip = new vscode.MarkdownString(lines.join("\n"));
      item.contextValue = "usage-summary";
      return item;
    }

    if (node.kind === "session") {
      const s = node.session;
      const item = new vscode.TreeItem(
        s.title,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      const ctx =
        s.latestContextPercent !== undefined
          ? ` · ${Math.round(s.latestContextPercent)}%`
          : "";
      const mode = s.agentMode === "cli" ? "CLI " : "";
      item.description = `${mode}⚡ ${fmtCredits(s.totalCredits)}${ctx}`;
      item.iconPath = new vscode.ThemeIcon(
        s.agentMode === "cli" ? "terminal" : "comment-discussion",
      );
      const lines = [
        `**${s.title}**`,
        "",
        t("Credits: {0}", fmtCredits(s.totalCredits)),
        t("Turns: {0}", s.turns.length),
        s.modelId ? t("Model: {0}", s.modelId) : "",
        s.agentMode ? t("Mode: {0}", s.agentMode) : "",
        s.latestContextPercent !== undefined
          ? t("Context window: {0}%", Math.round(s.latestContextPercent))
          : "",
        s.lastModifiedAt ? t("Last active: {0}", this.fmtWhen(s.lastModifiedAt)) : "",
      ].filter(Boolean);
      item.tooltip = new vscode.MarkdownString(lines.join("\n\n"));
      item.contextValue = "usage-session";
      return item;
    }

    if (node.kind === "intentGroup") {
      const credits = sumCredits(node.turns);
      const item = new vscode.TreeItem(
        this.intentLabel(node.intent),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = `⚡ ${fmtCredits(credits)} · ${t("{0} turns", node.turns.length)}`;
      item.iconPath = new vscode.ThemeIcon(
        node.intent === UNASSIGNED ? "question" : "target",
      );
      item.contextValue = "usage-intent";
      return item;
    }

    if (node.kind === "stageGroup") {
      const credits = sumCredits(node.turns);
      const item = new vscode.TreeItem(
        this.stageLabel(node.slug),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = `⚡ ${fmtCredits(credits)} · ${t("{0} turns", node.turns.length)}`;
      item.iconPath = new vscode.ThemeIcon("layers");
      item.contextValue = "usage-stage";
      return item;
    }

    // turn
    const tn = node.turn;
    const label = tn.prompt || t("(turn {0})", tn.index);
    const item = new vscode.TreeItem(
      `${tn.index}. ${label}`,
      vscode.TreeItemCollapsibleState.None,
    );
    const parts = [`⚡ ${fmtCredits(tn.credits)}`];
    const el = this.fmtElapsed(tn.elapsedMs);
    if (el) {
      parts.push(el);
    }
    if (tn.contextPercent !== undefined) {
      parts.push(`${Math.round(tn.contextPercent)}%`);
    }
    if (!tn.complete) {
      parts.push(t("running"));
    }
    item.description = parts.join(" · ");
    item.iconPath = new vscode.ThemeIcon(
      tn.complete ? "arrow-small-right" : "sync~spin",
    );
    const tip = [
      tn.prompt ? `**${tn.prompt}**` : `**${t("(turn {0})", tn.index)}**`,
      "",
      t("Credits: {0}", fmtCredits(tn.credits)),
      el ? t("Elapsed: {0}", el) : "",
      tn.contextPercent !== undefined
        ? t("Context window: {0}%", Math.round(tn.contextPercent))
        : "",
      tn.tools.length ? t("Tools: {0}", tn.tools.join(", ")) : "",
      tn.startedAt ? t("Started: {0}", this.fmtWhen(tn.startedAt)) : "",
    ].filter(Boolean);
    item.tooltip = new vscode.MarkdownString(tip.join("\n\n"));
    item.contextValue = "usage-turn";
    return item;
  }

  getChildren(element?: UsageNode): UsageNode[] {
    if (!this.usage.enabled) {
      return [
        {
          kind: "message",
          text: t("Token usage tracking is off. Turn it on in the Features view."),
        },
      ];
    }
    const u = this.usage.usage;
    if (!u) {
      return [{ kind: "message", text: t("Loading…") }];
    }
    if (!this.usage.root) {
      return [{ kind: "message", text: t("Not an AI-DLC workspace.") }];
    }
    if (!element) {
      if (u.sessions.length === 0) {
        return [
          {
            kind: "message",
            text: t("No Kiro sessions found for this workspace yet."),
          },
        ];
      }
      if (u.scope === "global") {
        // Group all sessions by their workspace/cwd, biggest spend first.
        const groups = new Map<string, SessionUsage[]>();
        for (const s of u.sessions) {
          const key = s.workspace ?? "";
          (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
        }
        const ordered = [...groups.entries()].sort(
          (a, b) =>
            b[1].reduce((s, x) => s + x.totalCredits, 0) -
            a[1].reduce((s, x) => s + x.totalCredits, 0),
        );
        return [
          { kind: "summary" },
          ...ordered.map(([workspace, sessions]) => ({
            kind: "workspaceGroup" as const,
            workspace,
            sessions,
          })),
        ];
      }
      return [
        { kind: "summary" },
        ...u.sessions.map((session) => ({ kind: "session" as const, session })),
      ];
    }

    if (element.kind === "workspaceGroup") {
      return element.sessions.map((session) => ({ kind: "session", session }));
    }

    if (element.kind === "session") {
      const anyAttributed = element.session.turns.some((tn) => tn.intentName);
      if (!anyAttributed) {
        // No audit correlation: list turns directly under the session.
        return element.session.turns.map((turn) => ({ kind: "turn", turn }));
      }
      // Group by attributed intent (unattributed turns under "Unassigned").
      return groupBy(
        element.session.turns,
        (tn) => tn.intentName ?? UNASSIGNED,
      ).map((g) => ({
        kind: "intentGroup",
        session: element.session,
        intent: g.key,
        turns: g.turns,
      }));
    }

    if (element.kind === "intentGroup") {
      if (element.intent === UNASSIGNED) {
        // Unattributed turns have no stage — list them flat.
        return element.turns.map((turn) => ({ kind: "turn", turn }));
      }
      return groupBy(element.turns, (tn) => tn.stageSlug ?? UNASSIGNED).map(
        (g) => ({ kind: "stageGroup", slug: g.key, turns: g.turns }),
      );
    }

    if (element.kind === "stageGroup") {
      return element.turns.map((turn) => ({ kind: "turn", turn }));
    }

    return [];
  }
}
