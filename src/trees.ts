import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { GitStatus } from "./git";
import { t } from "./i18n";
import { statusLabel } from "./labels";
import {
  ArtifactModel,
  isQuestionsArtifact,
  PanelStore,
  PhaseModel,
  StageModel,
  StageStatus,
} from "./model";
import { ReviewState } from "./review";
import { fmtCredits, UsageStore } from "./usage";

/** Auxiliary per-stage file that is not a formal artifact but useful to see
 *  alongside them: the observation diary. (Q&A `*-questions.md` files are
 *  produced artifacts and are listed in the artifact set, Q&A-tagged, not here.) */
interface AuxFile {
  file: string;
  badge: string;
}

/** Count unanswered [Answer]: tags in a questions file. */
function pendingBadge(file: string): string {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  let total = 0;
  let pending = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\[Answer\]:\s*(.*)$/);
    if (m) {
      total += 1;
      if (m[1].trim() === "") {
        pending += 1;
      }
    }
  }
  if (total === 0) {
    return t("Q&A");
  }
  return pending > 0
    ? t("{0}/{1} unanswered", pending, total)
    : t("answered");
}

function statusIcon(status: StageStatus): vscode.ThemeIcon {
  switch (status) {
    case "completed":
      return new vscode.ThemeIcon(
        "pass-filled",
        new vscode.ThemeColor("testing.iconPassed"),
      );
    case "in-progress":
      return new vscode.ThemeIcon(
        "sync",
        new vscode.ThemeColor("charts.blue"),
      );
    case "awaiting-approval":
      return new vscode.ThemeIcon(
        "clock",
        new vscode.ThemeColor("charts.yellow"),
      );
    case "revising":
      return new vscode.ThemeIcon(
        "edit",
        new vscode.ThemeColor("charts.orange"),
      );
    case "skipped":
      return new vscode.ThemeIcon("circle-slash");
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

/* ----------------------------- Progress tree ----------------------------- */

type ProgressNode =
  | { kind: "message"; text: string }
  | { kind: "usageTotal" }
  | { kind: "phase"; phase: PhaseModel }
  | { kind: "stage"; stage: StageModel };

export class ProgressProvider
  implements vscode.TreeDataProvider<ProgressNode>
{
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._emitter.event;

  private static readonly HIDE_COMPLETED_KEY = "aidlcPanel.hideCompleted";
  private static readonly HIDE_SKIPPED_KEY = "aidlcPanel.hideSkipped";
  private static readonly EXPAND_KEY = "aidlcPanel.progress.expand";

  constructor(
    private readonly store: PanelStore,
    private readonly memento: vscode.Memento,
    private readonly usage?: UsageStore,
  ) {
    store.onDidChange(() => this._emitter.fire());
    // Per-stage credit badges track usage refreshes too.
    usage?.onDidChange(() => this._emitter.fire());
  }

  /** Stable id for a collapsible node, or undefined for leaves we don't track. */
  private idOf(node: ProgressNode): string | undefined {
    return node.kind === "phase" ? `phase:${node.phase.phase}` : undefined;
  }

  /** Saved expand/collapse overrides (id → expanded). Absent ids use the
   *  node's default state. */
  private expandState(): Record<string, boolean> {
    return this.memento.get<Record<string, boolean>>(
      ProgressProvider.EXPAND_KEY,
      {},
    );
  }

  /** Collapsible state for a node, honoring the user's saved choice so tree
   *  expansion survives an IDE reload. */
  private collapsibleFor(
    id: string,
    defaultExpanded: boolean,
  ): vscode.TreeItemCollapsibleState {
    const saved = this.expandState()[id];
    const expanded = saved === undefined ? defaultExpanded : saved;
    return expanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
  }

  /** Record a node's expand/collapse so it is restored after a reload. */
  async setExpanded(node: ProgressNode, expanded: boolean): Promise<void> {
    const id = this.idOf(node);
    if (!id) {
      return;
    }
    await this.memento.update(ProgressProvider.EXPAND_KEY, {
      ...this.expandState(),
      [id]: expanded,
    });
  }

  /** Whether completed stages are collapsed out of the tree. */
  get hideCompleted(): boolean {
    return this.memento.get<boolean>(ProgressProvider.HIDE_COMPLETED_KEY, false);
  }

  /** Whether skipped stages are collapsed out of the tree. */
  get hideSkipped(): boolean {
    return this.memento.get<boolean>(ProgressProvider.HIDE_SKIPPED_KEY, false);
  }

  async setHideCompleted(value: boolean): Promise<void> {
    await this.memento.update(
      ProgressProvider.HIDE_COMPLETED_KEY,
      value || undefined,
    );
    await vscode.commands.executeCommand(
      "setContext",
      ProgressProvider.HIDE_COMPLETED_KEY,
      value,
    );
    this._emitter.fire();
  }

  async setHideSkipped(value: boolean): Promise<void> {
    await this.memento.update(
      ProgressProvider.HIDE_SKIPPED_KEY,
      value || undefined,
    );
    await vscode.commands.executeCommand(
      "setContext",
      ProgressProvider.HIDE_SKIPPED_KEY,
      value,
    );
    this._emitter.fire();
  }

  /** Push persisted toggle state into the when-context (call on activate). */
  async syncContext(): Promise<void> {
    await vscode.commands.executeCommand(
      "setContext",
      ProgressProvider.HIDE_COMPLETED_KEY,
      this.hideCompleted,
    );
    await vscode.commands.executeCommand(
      "setContext",
      ProgressProvider.HIDE_SKIPPED_KEY,
      this.hideSkipped,
    );
  }

  /** Apply the active collapse toggles to a phase's stage list. */
  private visibleStages(stages: StageModel[]): StageModel[] {
    return stages.filter((s) => {
      if (this.hideCompleted && s.status === "completed") {
        return false;
      }
      if (this.hideSkipped && s.status === "skipped") {
        return false;
      }
      return true;
    });
  }

  getTreeItem(node: ProgressNode): vscode.TreeItem {
    if (node.kind === "message") {
      return new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    }
    if (node.kind === "usageTotal") {
      // Stable, cumulative token usage for the whole active intent. Unlike a
      // single stage badge, this keeps growing as the workflow moves between
      // stages and across sessions (e.g. after a context reset), so it never
      // appears to "reset" to the latest session.
      const total = this.usage?.activeIntentTotal();
      const item = new vscode.TreeItem(
        t("Intent usage: {0} credits", fmtCredits(total?.credits ?? 0)),
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = total ? t("{0} turns", total.turns) : "";
      item.iconPath = new vscode.ThemeIcon("graph");
      item.tooltip = new vscode.MarkdownString(
        `${t("Cumulative token usage for the active intent, across all stages and sessions.")}\n\n` +
          t("Per-stage badges below show each stage's own usage."),
      );
      item.contextValue = "usage-total";
      return item;
    }
    if (node.kind === "phase") {
      const p = node.phase;
      const id = `phase:${p.phase}`;
      const item = new vscode.TreeItem(p.label, this.collapsibleFor(id, true));
      item.id = id;
      item.description =
        p.total === 0
          ? "— " + t("all skipped")
          : `${p.completed}/${p.total} · ${p.percent}%`;
      item.contextValue = "phase";
      item.iconPath = new vscode.ThemeIcon("layers");
      return item;
    }
    const s = node.stage;
    const item = new vscode.TreeItem(
      `${s.number} ${s.name}`,
      vscode.TreeItemCollapsibleState.None,
    );
    // Status label, plus a credit badge when this stage has attributed usage.
    const stageUsage = this.usage?.stageUsage(s.slug);
    item.description =
      stageUsage && stageUsage.credits > 0
        ? `${statusLabel(s.status)} · ⚡ ${fmtCredits(stageUsage.credits)}`
        : statusLabel(s.status);
    const assigned =
      [s.leadAgent, ...s.supportAgents].filter(Boolean).join(" · ") || "orchestrator";
    const usageLine =
      stageUsage && stageUsage.credits > 0
        ? `\n\n${t("Credits: {0}", fmtCredits(stageUsage.credits))} · ${t("{0} turns", stageUsage.turns)}`
        : "";
    item.tooltip = new vscode.MarkdownString(
      `**${s.number} ${s.name}**\n\n${s.purpose}\n\n${t("Assigned")}: ${assigned}${usageLine}`,
    );
    item.iconPath = statusIcon(s.status);
    item.contextValue = "stage";
    item.command = {
      command: "aidlcPanel.showStage",
      title: t("Open stage"),
      arguments: [s],
    };
    return item;
  }

  getChildren(element?: ProgressNode): ProgressNode[] {
    const model = this.store.model;
    if (!model) {
      return [{ kind: "message", text: t("Loading…") }];
    }
    if (!model.ok) {
      return [{ kind: "message", text: model.message ?? t("Unable to load state.") }];
    }
    if (!element) {
      const phases: ProgressNode[] = (model.phases ?? []).map((phase) => ({
        kind: "phase",
        phase,
      }));
      // Lead with the cumulative intent total when there is attributed usage,
      // so a stable "does not reset" number is always visible at the top.
      return this.usage?.activeIntentTotal()
        ? [{ kind: "usageTotal" }, ...phases]
        : phases;
    }
    if (element.kind === "phase") {
      const stages = this.visibleStages(element.phase.stages);
      if (stages.length === 0) {
        return [{ kind: "message", text: t("(No stages to show — check toggles)") }];
      }
      return stages.map((stage) => ({ kind: "stage", stage }));
    }
    return [];
  }
}

/* -------------------------- Artifacts & Review --------------------------- */

type ArtifactNode =
  | { kind: "message"; text: string }
  | { kind: "stage"; stage: StageModel }
  | {
      kind: "bolt";
      stage: StageModel;
      bolt: string;
      dir: string;
      artifacts: ArtifactModel[];
    }
  | { kind: "artifact"; stage: StageModel; artifact: ArtifactModel }
  | { kind: "aux"; stage: StageModel; aux: AuxFile };

export class ArtifactsProvider
  implements vscode.TreeDataProvider<ArtifactNode>
{
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._emitter.event;

  constructor(
    private readonly store: PanelStore,
    private readonly memento: vscode.Memento,
    private readonly review: ReviewState,
    private readonly git: GitStatus,
    private root: string,
  ) {
    store.onDidChange(() => this._emitter.fire());
    review.onDidChange(() => this._emitter.fire());
    // git status resolves asynchronously; re-render when its badge sets update.
    git.onDidChange(() => this._emitter.fire());
  }

  private static readonly EXPAND_KEY = "aidlcPanel.artifacts.expand";

  /** Retarget at a different AI-DLC workspace root and re-render. */
  setRoot(root: string): void {
    this.root = root;
    this._emitter.fire();
  }

  /** Stable id for a collapsible node (stage or Bolt group), else undefined. */
  private idOf(node: ArtifactNode): string | undefined {
    if (node.kind === "stage") {
      return `stage:${node.stage.slug}`;
    }
    if (node.kind === "bolt") {
      return `bolt:${node.stage.slug}/${node.bolt}`;
    }
    return undefined;
  }

  /** Saved expand/collapse overrides (id → expanded). */
  private expandState(): Record<string, boolean> {
    return this.memento.get<Record<string, boolean>>(
      ArtifactsProvider.EXPAND_KEY,
      {},
    );
  }

  /** Collapsible state honoring the user's saved choice so tree expansion
   *  survives an IDE reload. */
  private collapsibleFor(
    id: string,
    defaultExpanded: boolean,
  ): vscode.TreeItemCollapsibleState {
    const saved = this.expandState()[id];
    const expanded = saved === undefined ? defaultExpanded : saved;
    return expanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
  }

  /** Record a node's expand/collapse so it is restored after a reload. */
  async setExpanded(node: ArtifactNode, expanded: boolean): Promise<void> {
    const id = this.idOf(node);
    if (!id) {
      return;
    }
    await this.memento.update(ArtifactsProvider.EXPAND_KEY, {
      ...this.expandState(),
      [id]: expanded,
    });
  }

  /** Directory holding a stage's files. Prefer the dir of a known artifact
   *  (handles construction Bolt nesting); else fall back to phase/slug. */
  private stageDir(stage: StageModel): string | undefined {
    if (stage.artifacts.length > 0) {
      return path.dirname(stage.artifacts[0].absPath);
    }
    const m = this.store.model;
    if (!m || !m.ok || !m.intent) {
      return undefined;
    }
    return path.join(
      this.root,
      "aidlc",
      "spaces",
      m.space,
      "intents",
      m.intent,
      stage.phase,
      stage.slug,
    );
  }

  /** Questions files and the observation diary for a stage. */
  private auxFiles(stage: StageModel): AuxFile[] {
    const dir = this.stageDir(stage);
    return dir ? this.auxFilesInDir(dir) : [];
  }

  /** Observation diary (memory.md) found in a specific directory. Shared by
   *  the flat stage path and per-Bolt groups so each Bolt shows its own diary. */
  private auxFilesInDir(dir: string): AuxFile[] {
    const out: AuxFile[] = [];
    const diary = path.join(dir, "memory.md");
    if (fs.existsSync(diary)) {
      out.push({ file: diary, badge: t("Diary") });
    }
    return out;
  }

  /** Distinct Bolt names present in a stage's artifacts, in first-seen order. */
  private boltNames(stage: StageModel): string[] {
    const names: string[] = [];
    for (const a of stage.artifacts) {
      if (a.bolt && !names.includes(a.bolt)) {
        names.push(a.bolt);
      }
    }
    return names;
  }

  private static readonly AUX_KEY = "aidlcPanel.showAux";

  /** Whether to also list gate questions and diaries under each stage.
   *  Defaults to true ("show all") so nothing is hidden until the user opts to
   *  narrow the view to official artifacts only. */
  get showAux(): boolean {
    return this.memento.get<boolean>(ArtifactsProvider.AUX_KEY, true);
  }

  async setShowAux(value: boolean): Promise<void> {
    // Store the boolean explicitly: the default is now true, so collapsing
    // false to undefined would bounce the toggle back to "show all".
    await this.memento.update(ArtifactsProvider.AUX_KEY, value);
    await vscode.commands.executeCommand(
      "setContext",
      "aidlcPanel.showAux",
      value,
    );
    this._emitter.fire();
  }

  /** Push the persisted filter state into the when-context (call on activate). */
  async syncContext(): Promise<void> {
    await vscode.commands.executeCommand(
      "setContext",
      "aidlcPanel.showAux",
      this.showAux,
    );
  }

  isReviewed(artifact: ArtifactModel): boolean {
    return this.review.isReviewed(artifact.name);
  }

  async setReviewed(artifact: ArtifactModel, value: boolean): Promise<void> {
    await this.review.set(artifact.name, value);
  }

  getTreeItem(node: ArtifactNode): vscode.TreeItem {
    if (node.kind === "message") {
      return new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    }
    if (node.kind === "stage") {
      // Review counts are over prose artifacts only — Q&A files are answered,
      // not reviewed, so they never inflate the reviewed/total ratio.
      const reviewable = node.stage.artifacts.filter(
        (a) => !isQuestionsArtifact(a.name),
      );
      const total = reviewable.length;
      const reviewed = reviewable.filter((a) => this.isReviewed(a)).length;
      const id = `stage:${node.stage.slug}`;
      const item = new vscode.TreeItem(
        `${node.stage.number} ${node.stage.name}`,
        this.collapsibleFor(id, true),
      );
      item.id = id;
      if (total > 0) {
        const changed = reviewable.filter((a) =>
          this.git.state(a.absPath),
        ).length;
        item.description =
          t("{0}/{1} reviewed", reviewed, total) +
          (changed > 0 ? " · " + t("{0} changed", changed) : "");
      } else if (this.showAux) {
        const aux = this.auxFiles(node.stage).length;
        item.description = aux > 0 ? t("{0} refs", aux) : "";
      }
      item.iconPath = statusIcon(node.stage.status);
      item.contextValue = "artifact-group";
      return item;
    }
    if (node.kind === "bolt") {
      const id = `bolt:${node.stage.slug}/${node.bolt}`;
      const item = new vscode.TreeItem(node.bolt, this.collapsibleFor(id, true));
      item.id = id;
      item.iconPath = new vscode.ThemeIcon("package");
      item.contextValue = "artifact-bolt";
      // Per-Bolt reviewed/changed summary (prose artifacts only).
      const reviewable = node.artifacts.filter(
        (a) => !isQuestionsArtifact(a.absPath),
      );
      const total = reviewable.length;
      if (total > 0) {
        const reviewed = reviewable.filter((a) => this.isReviewed(a)).length;
        const changed = reviewable.filter((a) =>
          this.git.state(a.absPath),
        ).length;
        item.description =
          t("{0}/{1} reviewed", reviewed, total) +
          (changed > 0 ? " · " + t("{0} changed", changed) : "");
      }
      item.tooltip = node.dir;
      return item;
    }
    if (node.kind === "aux") {
      const item = new vscode.TreeItem(
        t("Diary (memory)"),
        vscode.TreeItemCollapsibleState.None,
      );
      item.resourceUri = vscode.Uri.file(node.aux.file);
      item.description = node.aux.badge;
      item.tooltip = node.aux.file;
      item.iconPath = new vscode.ThemeIcon("note");
      item.contextValue = "artifact-aux";
      item.command = {
        command: "aidlcPanel.openArtifact",
        title: t("Open"),
        arguments: [node.aux.file],
      };
      return item;
    }
    const reviewed = this.isReviewed(node.artifact);
    const isQuestions = isQuestionsArtifact(node.artifact.absPath);
    const change = this.git.state(node.artifact.absPath);
    const changeLabel =
      change === "new"
        ? "● " + t("new")
        : change === "changed"
          ? "● " + t("changed")
          : "";
    const uri = vscode.Uri.file(node.artifact.absPath);
    const base = node.artifact.name.split("/").pop() ?? node.artifact.name;
    const item = new vscode.TreeItem(base, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = uri;
    // Q&A artifacts carry their pending/answered badge (like the old aux Q&A
    // entry) so the same file is not listed twice; a comment icon marks the
    // Q&A distinction.
    item.description = (
      isQuestions
        ? [changeLabel, pendingBadge(node.artifact.absPath), reviewed ? t("reviewed") : ""]
        : [changeLabel, reviewed ? t("reviewed") : ""]
    )
      .filter(Boolean)
      .join(" · ");
    item.tooltip = node.artifact.name;
    item.iconPath = isQuestions
      ? new vscode.ThemeIcon("comment-discussion")
      : reviewed
        ? new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"))
        : new vscode.ThemeIcon("file");
    // Q&A files are answered, not reviewed — they carry a distinct contextValue
    // so the view-mode (rendered preview) icon can be scoped to them alone.
    item.contextValue = isQuestions
      ? "artifact-questions"
      : reviewed
        ? "artifact-reviewed"
        : "artifact-unreviewed";
    item.command = {
      command: "aidlcPanel.openArtifact",
      title: t("Open"),
      arguments: [node.artifact.absPath],
    };
    return item;
  }

  getChildren(element?: ArtifactNode): ArtifactNode[] {
    const model = this.store.model;
    if (!model) {
      return [{ kind: "message", text: t("Loading…") }];
    }
    if (!model.ok) {
      return [{ kind: "message", text: model.message ?? t("Unable to load artifacts.") }];
    }
    if (!element) {
      const stages = (model.stages ?? []).filter((s) => {
        const hasProse = s.artifacts.some((a) => !isQuestionsArtifact(a.absPath));
        const hasQuestions = s.artifacts.some((a) => isQuestionsArtifact(a.absPath));
        // Prose artifacts always keep a stage visible; Q&A artifacts and the
        // diary follow the Q&A/diary visibility toggle.
        return (
          hasProse ||
          (this.showAux && (hasQuestions || this.auxFiles(s).length > 0))
        );
      });
      if (stages.length === 0) {
        return [{ kind: "message", text: t("No artifacts produced yet.") }];
      }
      return stages.map((stage) => ({ kind: "stage", stage }));
    }
    // Q&A (`*-questions.md`) artifacts follow the Q&A/diary toggle, just like
    // the diary.
    const visible = (artifacts: ArtifactModel[]): ArtifactModel[] =>
      this.showAux
        ? artifacts
        : artifacts.filter((a) => !isQuestionsArtifact(a.absPath));

    if (element.kind === "stage") {
      const bolts = this.boltNames(element.stage);
      // Construction stages nest their output under one directory per Bolt.
      // Group by Bolt so every Bolt's artifacts show as its own bundle instead
      // of being flattened (and looking like duplicates) under the stage.
      if (bolts.length > 0) {
        const children: ArtifactNode[] = [];
        // Any non-Bolt files (rare) render directly under the stage first.
        for (const artifact of visible(
          element.stage.artifacts.filter((a) => !a.bolt),
        )) {
          children.push({ kind: "artifact", stage: element.stage, artifact });
        }
        for (const bolt of bolts) {
          const all = element.stage.artifacts.filter((a) => a.bolt === bolt);
          const dir = path.dirname(all[0].absPath);
          children.push({
            kind: "bolt",
            stage: element.stage,
            bolt,
            dir,
            artifacts: visible(all),
          });
        }
        return children;
      }

      const children: ArtifactNode[] = visible(element.stage.artifacts).map(
        (artifact) => ({ kind: "artifact", stage: element.stage, artifact }),
      );
      if (this.showAux) {
        for (const aux of this.auxFiles(element.stage)) {
          children.push({ kind: "aux", stage: element.stage, aux });
        }
      }
      return children;
    }

    if (element.kind === "bolt") {
      const children: ArtifactNode[] = element.artifacts.map((artifact) => ({
        kind: "artifact",
        stage: element.stage,
        artifact,
      }));
      if (this.showAux) {
        for (const aux of this.auxFilesInDir(element.dir)) {
          children.push({ kind: "aux", stage: element.stage, aux });
        }
      }
      return children;
    }
    return [];
  }

  /** Find an artifact node by its absolute path (used by review commands). */
  findArtifact(absPath: string): { stage: StageModel; artifact: ArtifactModel } | undefined {
    for (const stage of this.store.model?.stages ?? []) {
      for (const artifact of stage.artifacts) {
        if (artifact.absPath === absPath) {
          return { stage, artifact };
        }
      }
    }
    return undefined;
  }
}
