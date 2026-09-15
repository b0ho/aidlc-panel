import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ActionsProvider } from "./actions";
import { readStageEvents } from "./audit";
import {
  addAction,
  deleteAction,
  getCustomActions,
  promptForAction,
  updateAction,
  type CustomAction,
} from "./customActions";
import { GitStatus } from "./git";
import {
  initI18n,
  languagePref,
  onDidChangeLanguage,
  setLanguagePref,
  t,
  type LangPref,
} from "./i18n";
import {
  ensureModelTool,
  findAidlcRoots,
  isQuestionsArtifact,
  PanelStore,
  StageModel,
} from "./model";
import { NotepadViewProvider } from "./notepad";
import { OverviewViewProvider } from "./overviewView";
import { QuestionDetailPanel } from "./questionDetail";
import { ReferenceProvider } from "./reference";
import { ReviewState } from "./review";
import { StageDetailPanel } from "./stageDetail";
import { TipDetailPanel } from "./tipDetail";
import { findTip, TipsProvider } from "./tips";
import { ArtifactsProvider, ProgressProvider } from "./trees";
import { fmtCredits, loadUsage, UsageStore, type UsageScope } from "./usage";
import { UsageProvider } from "./usageView";

const HEAD_SCHEME = "aidlc-panel-head";

/** Active intent record directory (…/intents/<intent>) for the current model,
 *  or undefined when there is no active intent. Drives audit-based stage
 *  attribution for usage. */
function recordDirOf(
  model: PanelStore["model"],
  root: string | undefined,
): string | undefined {
  if (model && model.ok && model.intent && root) {
    return path.join(root, "aidlc", "spaces", model.space, "intents", model.intent);
  }
  return undefined;
}

/**
 * The AI-DLC root that owns the active editor's file, if that root is one of
 * the open AI-DLC workspaces. Returns undefined when there is no editor or the
 * file lives outside every AI-DLC folder.
 */
function rootOfActiveEditor(roots: string[]): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!folder) {
    return undefined;
  }
  return roots.find((r) => r === folder.uri.fsPath);
}

/**
 * Decide which AI-DLC root the panel should target. Prefers the root that owns
 * the active editor (so opening a file in another project switches the panel to
 * it), otherwise keeps the current selection when it is still valid, and falls
 * back to the first root.
 */
function pickActiveRoot(
  roots: string[],
  current: string | undefined,
): string | undefined {
  if (roots.length === 0) {
    return undefined;
  }
  const fromEditor = rootOfActiveEditor(roots);
  if (fromEditor) {
    return fromEditor;
  }
  if (current && roots.includes(current)) {
    return current;
  }
  return roots[0];
}

/**
 * Resolve which custom action an edit/delete command targets. Inline tree
 * buttons pass the tree node, the command palette passes nothing (so we show a
 * picker), and programmatic callers may pass the id directly.
 */
async function resolveCustomAction(
  arg: unknown,
): Promise<CustomAction | undefined> {
  const actions = getCustomActions();
  if (arg && typeof arg === "object" && "action" in arg) {
    const a = (arg as { action?: CustomAction }).action;
    if (a && typeof a.id === "string") {
      return actions.find((x) => x.id === a.id) ?? a;
    }
  }
  if (typeof arg === "string") {
    const found = actions.find((x) => x.id === arg);
    if (found) {
      return found;
    }
  }
  if (actions.length === 0) {
    vscode.window.showInformationMessage(t("No custom actions yet."));
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    actions.map((a) => ({
      label: a.label,
      description: a.newSession ? t("new session") : t("current session"),
      id: a.id,
    })),
    { placeHolder: t("Select a custom action") },
  );
  return pick ? actions.find((x) => x.id === pick.id) : undefined;
}

// Candidate command ids that (on some Kiro/VS Code builds) open the chat and
// accept a query. There is no documented public API, so we probe what exists
// at runtime and try, most-specific first. Anything not present is skipped.
const CHAT_COMMAND_CANDIDATES = [
  "kiroAgent.openChat",
  "kiroAgent.sendToChat",
  "kiro.chat.open",
  "kiro.openChat",
  "aws.amazonq.openChat",
  "amazonq.openChat",
  "workbench.action.chat.open",
  "workbench.action.chat.newChat",
];

// Candidate command ids that start a FRESH chat/session (as opposed to reusing
// the currently focused one). A review request should land in a clean session
// so prior context does not bleed in. Same runtime-probe strategy: try the
// most specific first, skip anything not present on this build.
const NEW_CHAT_COMMAND_CANDIDATES = [
  "kiroAgent.newChat",
  "kiroAgent.newSession",
  "kiroAgent.newTask",
  "kiro.chat.newSession",
  "kiro.chat.new",
  "kiro.newChat",
  "aws.amazonq.newChat",
  "amazonq.newChat",
  "workbench.action.chat.newChat",
  "workbench.action.chat.new",
];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Best-effort: open a brand-new Kiro chat session. Returns true if a present
 * "new chat" command executed without throwing. Non-fatal on failure — the
 * caller falls back to whatever chat is currently open.
 */
async function openNewKiroSession(allCommands: string[]): Promise<boolean> {
  const present = NEW_CHAT_COMMAND_CANDIDATES.filter((id) =>
    allCommands.includes(id),
  );
  for (const id of present) {
    try {
      await vscode.commands.executeCommand(id);
      return true;
    } catch {
      /* try next candidate */
    }
  }
  return false;
}

/**
 * Best-effort: hand a prompt to the Kiro chat. By default this opens a NEW
 * session first (review requests should not inherit prior context), then tries
 * any present chat command with the prompt as argument. If no command accepts
 * the query, at least the fresh session and context file are ready for the user
 * to type into. Pass { newSession: false } to reuse the current chat.
 */
async function sendToKiro(
  prompt: string,
  contextFile?: string,
  opts?: { newSession?: boolean },
): Promise<void> {
  // Open the target file so it becomes the active editor — Kiro chat then
  // references it as context (the same "open the file" flow as artifact review).
  // No clipboard/paste step.
  if (contextFile) {
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(contextFile), {
        preview: false,
      });
    } catch {
      /* ignore open failure */
    }
  }
  const all = await vscode.commands.getCommands(true);

  // Start a fresh session for review requests (default). Give the new chat a
  // moment to mount before we try to submit into it.
  let freshSession = false;
  if (opts?.newSession !== false) {
    freshSession = await openNewKiroSession(all);
    if (freshSession) {
      await sleep(250);
    }
  }

  // Put the prompt into the Kiro chat input (and always onto the clipboard as a
  // guaranteed fallback). Whether it is auto-sent or just pasted for review is
  // controlled by the aidlcPanel.autoSubmitPrompts setting.
  const outcome = await deliverPromptToChat(prompt, all);

  const where = freshSession ? t("a new Kiro session") : t("Kiro chat");
  const pasteKey = process.platform === "darwin" ? "Cmd+V" : "Ctrl+V";
  if (outcome === "submitted") {
    vscode.window.setStatusBarMessage(
      t("$(comment-discussion) Sent the prompt to {0}.", where),
      4000,
    );
  } else {
    // We cannot reliably confirm the text landed in the chat input on every
    // Kiro build, so we don't claim it did. The clipboard always has it — tell
    // the user the one-key paste that is guaranteed to work.
    void vscode.window.showInformationMessage(
      t(
        "Opened {0} and copied the prompt to the clipboard. Press {1} in the chat to paste, then Enter.",
        where,
        pasteKey,
      ),
    );
  }
}

/** Whether custom/workflow prompts should be sent immediately (query-submit)
 *  rather than left for the user to paste and send. Defaults to false so
 *  nothing is submitted without a look. */
function autoSubmitPrompts(): boolean {
  return vscode.workspace
    .getConfiguration("aidlcPanel")
    .get<boolean>("autoSubmitPrompts", false);
}

type DeliverOutcome = "submitted" | "copied" | "opened";

// Commands that focus the chat input box, tried before a programmatic paste.
// Runtime-probed like the open/new candidates — unknown ones are skipped.
const CHAT_FOCUS_CANDIDATES = [
  "kiroAgent.focusChatInput",
  "kiroAgent.focusChat",
  "aws.amazonq.focusChat",
  "workbench.action.chat.focusInput",
  "workbench.action.chat.open",
];

/**
 * Best-effort delivery of `prompt` to the Kiro chat. Always copies to the
 * clipboard first (the guaranteed manual-paste fallback).
 *  - autoSubmit on: try query-submit shapes; return "submitted" if one runs.
 *  - autoSubmit off (default): open + focus the chat and attempt a real paste
 *    (editor paste command) so the text lands in the input for review. We can't
 *    verify the paste on every build, so we report "opened"/"copied" (honest)
 *    and the caller tells the user the guaranteed one-key paste.
 */
async function deliverPromptToChat(
  prompt: string,
  all: string[],
): Promise<DeliverOutcome> {
  let copied = false;
  try {
    await vscode.env.clipboard.writeText(prompt);
    copied = true;
  } catch {
    /* clipboard unavailable */
  }

  const present = CHAT_COMMAND_CANDIDATES.filter((id) => all.includes(id));

  if (autoSubmitPrompts()) {
    // Try to submit the query outright. First shape that doesn't throw wins.
    const shapes: unknown[] = [
      { query: prompt },
      { prompt },
      { message: prompt },
      { text: prompt },
      prompt,
    ];
    for (const id of present) {
      for (const arg of shapes) {
        try {
          await vscode.commands.executeCommand(id, arg);
          return "submitted";
        } catch {
          /* try next shape */
        }
      }
    }
  }

  // Open a chat (no arg), focus its input, then paste from the clipboard.
  for (const id of present) {
    try {
      await vscode.commands.executeCommand(id);
      break;
    } catch {
      /* try next */
    }
  }
  await sleep(150);
  for (const id of CHAT_FOCUS_CANDIDATES) {
    if (!all.includes(id)) {
      continue;
    }
    try {
      await vscode.commands.executeCommand(id);
      break;
    } catch {
      /* try next */
    }
  }
  // editor.action.clipboardPasteAction pastes into the focused editor-like
  // input (Kiro's chat box is a Monaco input on most builds). Best-effort.
  try {
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
  } catch {
    /* not an editor context; user pastes manually */
  }
  return copied ? "copied" : "opened";
}

/** Resolve an absolute artifact path from a command argument that may be
 *  either a raw path string (tree item command) or an ArtifactNode (context menu). */
function argToAbsPath(arg: unknown): string | undefined {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg && typeof arg === "object") {
    const node = arg as {
      artifact?: { absPath?: string };
      aux?: { file?: string };
    };
    if (node.artifact?.absPath) {
      return node.artifact.absPath;
    }
    if (node.aux?.file) {
      return node.aux.file;
    }
  }
  return undefined;
}

/** A resolved status-bar state: what to show, how to style it, what clicking
 *  does, and (optionally) a one-shot notification to raise when it appears. */
interface StatusState {
  /** Stable identity of this state; drives one-shot notification de-duplication. */
  key: string;
  text: string;
  tooltip: string;
  /** Warning-tinted background — reserved for states that block on the user. */
  warn: boolean;
  command: string | vscode.Command;
  notify?: { message: string; action: string; run: () => void };
}

/**
 * Derive the single most relevant workflow state for the status bar from the
 * current model. Priority (highest first): parked → awaiting-approval →
 * open Q&A questions → revising → running. Returns undefined when there is no
 * active workflow or nothing worth surfacing (e.g. all stages pending/complete).
 */
function computeStatusState(store: PanelStore): StatusState | undefined {
  const m = store.model;
  if (!m || !m.ok) {
    return undefined;
  }

  // Parked outranks everything — the whole workflow is intentionally suspended.
  if (m.parked) {
    const at = m.parkedAtStage ? ` (${m.parkedAtStage})` : "";
    return {
      key: "parked",
      text: t("$(debug-pause) AI-DLC parked"),
      tooltip: t("Workflow parked{0} — click to resume", at),
      warn: false,
      command: "aidlcPanel.parkToggle",
    };
  }

  const cur = (m.stages ?? []).find((s) => s.slug === m.currentStage);
  if (!cur) {
    return undefined;
  }
  const openStage: vscode.Command = {
    command: "aidlcPanel.showStage",
    title: t("Open stage"),
    arguments: [cur],
  };

  // Gate open — the workflow needs an approve/reject decision.
  if (cur.status === "awaiting-approval") {
    return {
      key: `approval:${cur.slug}`,
      text: t("$(clock) Awaiting approval: {0} {1}", cur.number, cur.name),
      tooltip: t("AI-DLC gate awaiting approval — click to open stage"),
      warn: true,
      command: openStage,
      notify: {
        message: t("AI-DLC awaiting approval: {0} {1}", cur.number, cur.name),
        action: t("Open stage"),
        run: () => StageDetailPanel.show(cur),
      },
    };
  }

  // Q&A pending — a questions file has unanswered [Answer]: markers.
  const open = cur.openQuestions ?? 0;
  if (open > 0) {
    const qf = cur.questionsFile ?? undefined;
    const total = cur.totalQuestions ?? open;
    const openCmd: string | vscode.Command = qf
      ? { command: "aidlcPanel.openArtifact", title: t("Open questions"), arguments: [qf] }
      : "aidlcPanel.refresh";
    return {
      key: `questions:${cur.slug}`,
      text: t("$(question) Awaiting answers: {0} open", open),
      tooltip: t("{0} of {1} questions awaiting answers — click to open the questions file", open, total),
      warn: true,
      command: openCmd,
      notify: qf
        ? {
            message: t("AI-DLC awaiting answers: {0} {1} ({2} open)", cur.number, cur.name, open),
            action: t("Open questions"),
            run: () => void vscode.commands.executeCommand("aidlcPanel.openArtifact", qf),
          }
        : undefined,
    };
  }

  // Gate rejected — the agent is reworking the stage per the feedback.
  if (cur.status === "revising") {
    return {
      key: `revising:${cur.slug}`,
      text: t("$(edit) Revising: {0} {1}", cur.number, cur.name),
      tooltip: t("AI-DLC reworking after gate rejection — click to open stage"),
      warn: false,
      command: openStage,
    };
  }

  // Actively running the current stage.
  if (cur.status === "in-progress") {
    return {
      key: `running:${cur.slug}`,
      text: t("$(sync~spin) In progress: {0} {1}", cur.number, cur.name),
      tooltip: t("AI-DLC in progress — {0} (click to open stage)", m.nextAction ?? cur.name),
      warn: false,
      command: openStage,
    };
  }

  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  // Load translations + language preference before anything renders.
  initI18n(context);

  // The AI-DLC workspace the panel currently targets. In a multi-root
  // workspace several folders can each host an engine; instead of pinning to
  // the first one forever, we track all of them (`roots`) and keep an active
  // selection (`root`) that follows the editor the user is working in and can
  // be switched by hand. Everything downstream reads this mutable `root`, so a
  // switch retargets the whole panel (see switchRoot).
  let roots = findAidlcRoots();
  let root = pickActiveRoot(roots, undefined);
  // Install the read-only model tool into the workspace's .kiro/tools so it
  // sits beside aidlc-lib.ts (which it imports). Runs on every AI-DLC
  // workspace, so the panel works in new windows without manual setup.
  if (root) {
    ensureModelTool(root, context.extensionPath);
  }

  const store = new PanelStore(root);
  const USAGE_SCOPE_KEY = "aidlcPanel.usageScope";
  const initialUsageScope = context.workspaceState.get<UsageScope>(
    USAGE_SCOPE_KEY,
    "workspace",
  );
  const USAGE_PERIOD_KEY = "aidlcPanel.usagePeriod";
  const initialUsagePeriod = context.workspaceState.get<string>(
    USAGE_PERIOD_KEY,
    "",
  );
  const USAGE_ENABLED_KEY = "aidlcPanel.usageTracking";
  const initialUsageEnabled = context.globalState.get<boolean>(
    USAGE_ENABLED_KEY,
    true,
  );
  const usage = new UsageStore(
    root,
    undefined,
    initialUsageScope,
    initialUsagePeriod,
    initialUsageEnabled,
  );
  void vscode.commands.executeCommand(
    "setContext",
    "aidlcPanel.usageGlobal",
    initialUsageScope === "global",
  );
  const review = new ReviewState(context.workspaceState, store);
  const git = new GitStatus(root);
  const overview = new OverviewViewProvider(store, review);
  const progress = new ProgressProvider(store, context.workspaceState, usage);
  const usageView = new UsageProvider(usage, store);
  const artifacts = new ArtifactsProvider(
    store,
    context.workspaceState,
    review,
    git,
    root ?? "",
  );
  const reference = new ReferenceProvider(store, root ?? "");
  const tips = new TipsProvider();
  const notepad = new NotepadViewProvider(context.workspaceState);
  const tasks = new ActionsProvider(store, "tasks");
  const features = new ActionsProvider(store, "features", () => usage.enabled);
  void artifacts.syncContext();
  void progress.syncContext();

  // Status-bar indicator that reflects the current workflow state (awaiting
  // approval, waiting on Q&A answers, revising, running, parked) plus a
  // one-shot notification for the states that need the user to act. Hidden
  // when there is no active intent or nothing noteworthy is happening.
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  context.subscriptions.push(statusItem);
  let lastNotifiedKey: string | undefined;

  const updateStatusUi = (): void => {
    const state = computeStatusState(store);
    if (!state) {
      statusItem.hide();
      lastNotifiedKey = undefined;
      return;
    }
    statusItem.text = state.text;
    statusItem.tooltip = state.tooltip;
    statusItem.command = state.command;
    statusItem.backgroundColor = state.warn
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    statusItem.show();

    const notify = state.notify;
    if (notify && state.key !== lastNotifiedKey) {
      void vscode.window
        .showInformationMessage(notify.message, notify.action)
        .then((choice) => {
          if (choice === notify.action) {
            notify.run();
          }
        });
    }
    // Track the latest key so a one-shot notification fires only once per
    // distinct actionable state (and re-fires when the state genuinely changes).
    lastNotifiedKey = state.key;
  };

  // Keep git-change badges fresh, re-render the open stage-detail panel, and
  // drive the approval indicator whenever the model reloads.
  git.refresh();
  store.onDidChange(() => {
    git.refresh();
    // Retarget usage at the active intent's record dir, then reload it so
    // per-stage credit badges and the usage view track the current model.
    usage.setRecordDir(recordDirOf(store.model, root));
    usage.refresh();
    StageDetailPanel.refresh();
    updateStatusUi();
  });
  // Per-stage detail credit card also refreshes when usage reloads.
  usage.onDidChange(() => StageDetailPanel.refresh());
  review.onDidChange(() => StageDetailPanel.refresh());
  // git status resolves asynchronously; refresh the stage-detail change badges
  // when it lands (the artifacts tree subscribes to git directly).
  git.onDidChange(() => StageDetailPanel.refresh());

  /* ----------------------- Workspace targeting -------------------------- */

  // Debounced model reload, shared by the file watchers below. Hoisted here so
  // installWatchers (which is re-run on every root switch) can reference it.
  let refreshDebounce: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (): void => {
    if (refreshDebounce) {
      clearTimeout(refreshDebounce);
    }
    // 500ms coalesces the bursts an agent produces when it writes several
    // files at once into a single model reload.
    refreshDebounce = setTimeout(() => store.refresh(), 500);
  };

  // File watchers are scoped to a single root's `aidlc/` tree, so they must be
  // re-created whenever the panel switches to a different root. Track the live
  // ones and dispose them before installing the new set.
  let watcherDisposables: vscode.Disposable[] = [];
  const installWatchers = (target: string | undefined): void => {
    for (const d of watcherDisposables) {
      d.dispose();
    }
    watcherDisposables = [];
    if (!target) {
      return;
    }
    const track = (w: vscode.FileSystemWatcher): void => {
      watcherDisposables.push(w);
      context.subscriptions.push(w);
    };

    // Structure changes: any artifact markdown appearing or disappearing —
    // including a new file inside a construction Bolt directory
    // (`construction/<bolt>/<stage>/*.md`) or a brand-new Bolt subdirectory —
    // changes the tree, so reload on create/delete. We deliberately DO NOT
    // reload on content edits (onDidChange) here: re-saving an artifact's text
    // does not change the tree, and reacting to every save would spawn the
    // model tool far too often during an active run.
    const structureWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(target, "aidlc/**/*.md"),
    );
    structureWatcher.onDidCreate(scheduleRefresh);
    structureWatcher.onDidDelete(scheduleRefresh);
    track(structureWatcher);

    // Content-driven status: aidlc-state.md (current stage / status) and
    // `*-questions.md` (open vs answered counts) DO need a reload when their
    // contents change, so the status bar and Q&A badges stay live.
    const stateWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(target, "aidlc/**/{aidlc-state.md,*-questions.md}"),
    );
    stateWatcher.onDidChange(scheduleRefresh);
    stateWatcher.onDidCreate(scheduleRefresh);
    stateWatcher.onDidDelete(scheduleRefresh);
    track(stateWatcher);

    // Cursor files carry no extension, so watch them separately: active-space
    // at the space root and active-intent under each space's intents dir. A
    // change here switches the active intent/space, which reshapes everything.
    const cursorWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(target, "aidlc/**/{active-intent,active-space}"),
    );
    cursorWatcher.onDidChange(scheduleRefresh);
    cursorWatcher.onDidCreate(scheduleRefresh);
    cursorWatcher.onDidDelete(scheduleRefresh);
    track(cursorWatcher);
  };

  // Expose whether more than one AI-DLC workspace is open so the "switch
  // workspace" title button only appears when it is actually useful.
  const syncWorkspaceContext = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "aidlcPanel.multiRoot",
      roots.length > 1,
    );
  };

  // Retarget the entire panel at a different AI-DLC root. Order matters: update
  // git's root before the store reloads, because the store's onDidChange runs
  // git.refresh() and we want it to read the new working tree.
  const switchRoot = (next: string | undefined): void => {
    if (next === root) {
      return;
    }
    root = next;
    if (root) {
      ensureModelTool(root, context.extensionPath);
    }
    git.setRoot(root);
    artifacts.setRoot(root ?? "");
    reference.setRoot(root ?? "");
    usage.setRoot(root); // store-only; the store reload below drives usage.refresh
    installWatchers(root);
    store.setRoot(root); // reloads the model, which cascades git + status UI
    updateStatusUi();
  };

  // Follow the editor: opening a file that belongs to another open AI-DLC
  // project switches the panel to that project. Files outside every AI-DLC
  // folder (or in the current one) leave the selection untouched.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      const match = rootOfActiveEditor(roots);
      if (match && match !== root) {
        switchRoot(match);
      }
    }),
    // Folders added/removed change the candidate set; recompute and re-target
    // if the current selection went away.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      roots = findAidlcRoots();
      syncWorkspaceContext();
      if (!root || !roots.includes(root)) {
        switchRoot(pickActiveRoot(roots, root));
      }
    }),
  );

  installWatchers(root);
  syncWorkspaceContext();

  // NOTE: usage is refreshed on model reloads (see store.onDidChange) and when
  // the Token Usage view becomes visible (wired after the view is created), not
  // by watching ~/.kiro/sessions. A recursive watcher over that store (which
  // holds large snapshots/ trees) starved the workspace's own aidlc/** watchers
  // and slowed the whole panel — so we deliberately do not watch it.

  // Stage-detail data source: audit timeline + review flags + git change state.
  StageDetailPanel.setExtrasProvider((stage) => {
    const m = store.model;
    const rec =
      m && m.ok && m.intent && root
        ? path.join(root, "aidlc", "spaces", m.space, "intents", m.intent)
        : undefined;
    return {
      events: rec ? readStageEvents(rec, stage.slug) : [],
      reviewed: new Set(
        stage.artifacts
          .filter((a) => review.isReviewed(a.name))
          .map((a) => a.name),
      ),
      changeState: (abs) => git.state(abs),
      usage: usage.stageUsage(stage.slug),
    };
  });

  // Tree views are created (not just registered) so their section titles can be
  // relabelled live when the panel language switches.
  const actionsView = vscode.window.createTreeView("aidlcPanelActions", {
    treeDataProvider: tasks,
  });
  const featuresView = vscode.window.createTreeView("aidlcPanelFeatures", {
    treeDataProvider: features,
  });
  const progressView = vscode.window.createTreeView("aidlcPanelProgress", {
    treeDataProvider: progress,
  });
  const artifactsView = vscode.window.createTreeView("aidlcPanelArtifacts", {
    treeDataProvider: artifacts,
  });
  const referenceView = vscode.window.createTreeView("aidlcPanelReference", {
    treeDataProvider: reference,
  });
  const tipsView = vscode.window.createTreeView("aidlcPanelTips", {
    treeDataProvider: tips,
  });
  const usageTreeView = vscode.window.createTreeView("aidlcPanelUsage", {
    treeDataProvider: usageView,
  });
  // Refresh usage lazily: when the Token Usage view is shown, and — while it
  // stays visible — on a slow poll so an active conversation's new turns appear
  // without the cost of watching the whole session store. The scan is async and
  // cache-backed (only changed session logs re-parse), so this is cheap.
  let usagePoll: ReturnType<typeof setInterval> | undefined;
  const stopUsagePoll = (): void => {
    if (usagePoll) {
      clearInterval(usagePoll);
      usagePoll = undefined;
    }
  };
  context.subscriptions.push(
    usageTreeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        usage.refresh();
        if (!usagePoll) {
          usagePoll = setInterval(() => {
            if (usageTreeView.visible) {
              usage.refresh();
            }
          }, 15000);
        }
      } else {
        stopUsagePoll();
      }
    }),
    { dispose: stopUsagePoll },
  );
  const setViewTitles = (): void => {
    actionsView.title = t("Tasks");
    featuresView.title = t("Features");
    progressView.title = t("Stages");
    artifactsView.title = t("Artifacts & Review");
    referenceView.title = t("Reference & History");
    tipsView.title = t("Tips & Help");
    usageTreeView.title = t("Token Usage");
    // Short guidance at the top of the view: clearing context erases the local
    // credit history, so continue in a new session instead of /clear · /compact.
    usageTreeView.message = t(
      "Tip: to keep usage history, continue in a new session\n— /clear and /compact erase it.",
    );
    overview.setTitle(t("Overview"));
    notepad.setTitle(t("Notepad"));
  };
  setViewTitles();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("aidlcPanelOverview", overview),
    vscode.window.registerWebviewViewProvider("aidlcPanelNotepad", notepad, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    actionsView,
    featuresView,
    progressView,
    artifactsView,
    referenceView,
    tipsView,
    usageTreeView,
  );

  // Persist tree expand/collapse across IDE reloads: VS Code does not remember
  // item expansion on its own, so we record it per view in workspaceState and
  // re-apply it when the tree items are rebuilt.
  progressView.onDidExpandElement((e) => void progress.setExpanded(e.element, true));
  progressView.onDidCollapseElement((e) => void progress.setExpanded(e.element, false));
  artifactsView.onDidExpandElement((e) => void artifacts.setExpanded(e.element, true));
  artifactsView.onDidCollapseElement((e) => void artifacts.setExpanded(e.element, false));

  // Live re-render everything when the panel language changes.
  context.subscriptions.push(
    onDidChangeLanguage(() => {
      setViewTitles();
      tips.refresh();
      StageDetailPanel.refresh();
      TipDetailPanel.refresh();
      updateStatusUi();
      store.refresh(); // re-runs the model tool with the new --lang
    }),
  );

  // Read-only virtual document that serves the git-HEAD version of an artifact,
  // used as the left side of the diff. Path carries the repo-relative path so
  // the editor picks the right language.
  const headProvider = new (class
    implements vscode.TextDocumentContentProvider
  {
    provideTextDocumentContent(uri: vscode.Uri): string {
      if (!root) {
        return "";
      }
      const rel = uri.path.replace(/^\//, "");
      // No shell: git is a `.exe` (PATH-resolvable) and args are passed as an
      // array, so the path needs no quoting and can't be shell-injected.
      const res = cp.spawnSync("git", ["-C", root, "show", `HEAD:${rel}`], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      return res.status === 0 ? (res.stdout ?? "") : "";
    }
  })();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      HEAD_SCHEME,
      headProvider,
    ),
  );

  /* ------------------------------ Commands ------------------------------ */

  context.subscriptions.push(
    vscode.commands.registerCommand("aidlcPanel.refresh", () => store.refresh()),

    // Manually pick which open AI-DLC project the panel targets. The panel also
    // follows the active editor automatically; this is the explicit override
    // for when several AI-DLC folders are open at once.
    vscode.commands.registerCommand("aidlcPanel.selectWorkspace", async () => {
      roots = findAidlcRoots();
      syncWorkspaceContext();
      if (roots.length <= 1) {
        vscode.window.showInformationMessage(
          t("Only one AI-DLC workspace is open."),
        );
        return;
      }
      const items = roots.map((r) => ({
        label: `${r === root ? "● " : ""}${path.basename(r)}`,
        description: r,
        target: r,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: t("Select the AI-DLC workspace to show"),
      });
      if (pick) {
        switchRoot(pick.target);
      }
    }),

    // Run a user-defined custom action: hand its prompt to Kiro exactly like
    // "Continue workflow", honoring the action's new-session preference.
    vscode.commands.registerCommand(
      "aidlcPanel.runCustomAction",
      async (arg: unknown) => {
        const id = typeof arg === "string" ? arg : undefined;
        const action = getCustomActions().find((a) => a.id === id);
        if (!action) {
          return;
        }
        await sendToKiro(action.prompt, undefined, {
          newSession: action.newSession,
        });
      },
    ),

    // Guided create flow (label → prompt → new-session choice), then persist.
    vscode.commands.registerCommand("aidlcPanel.addCustomAction", async () => {
      const created = await promptForAction();
      if (created) {
        await addAction(created);
      }
    }),

    // Edit an existing custom action. Accepts either the action id (from the
    // inline button) or falls back to a picker.
    vscode.commands.registerCommand(
      "aidlcPanel.editCustomAction",
      async (arg: unknown) => {
        const existing = await resolveCustomAction(arg);
        if (!existing) {
          return;
        }
        const edited = await promptForAction(existing);
        if (edited) {
          await updateAction(edited);
        }
      },
    ),

    // Delete a custom action (with a confirmation), by id or via a picker.
    vscode.commands.registerCommand(
      "aidlcPanel.deleteCustomAction",
      async (arg: unknown) => {
        const existing = await resolveCustomAction(arg);
        if (!existing) {
          return;
        }
        const del = t("Delete");
        const confirm = await vscode.window.showWarningMessage(
          t('Delete the custom action "{0}"?', existing.label),
          { modal: true },
          del,
        );
        if (confirm === del) {
          await deleteAction(existing.id);
        }
      },
    ),

    // Switch the panel language independently of the IDE (auto / en / ko).
    vscode.commands.registerCommand("aidlcPanel.setLanguage", async () => {
      const cur = languagePref();
      const dot = (v: LangPref): string => (cur === v ? "●" : "");
      const items: { label: string; description: string; val: LangPref }[] = [
        { label: t("Auto (follow IDE)"), description: dot("auto"), val: "auto" },
        { label: "English", description: dot("en"), val: "en" },
        { label: "한국어", description: dot("ko"), val: "ko" },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: t("Select the panel language"),
      });
      if (pick) {
        await setLanguagePref(pick.val);
      }
    }),

    vscode.commands.registerCommand("aidlcPanel.showAuxOn", () =>
      artifacts.setShowAux(true),
    ),
    vscode.commands.registerCommand("aidlcPanel.showAuxOff", () =>
      artifacts.setShowAux(false),
    ),

    // Progress-tree collapse toggles: hide/show completed and skipped stages.
    vscode.commands.registerCommand("aidlcPanel.hideCompletedOn", () =>
      progress.setHideCompleted(true),
    ),
    vscode.commands.registerCommand("aidlcPanel.hideCompletedOff", () =>
      progress.setHideCompleted(false),
    ),
    vscode.commands.registerCommand("aidlcPanel.hideSkippedOn", () =>
      progress.setHideSkipped(true),
    ),
    vscode.commands.registerCommand("aidlcPanel.hideSkippedOff", () =>
      progress.setHideSkipped(false),
    ),

    vscode.commands.registerCommand("aidlcPanel.init", () => {
      if (!root) {
        vscode.window.showWarningMessage(
          t("Not an AI-DLC workspace (.kiro/tools/aidlc-lib.ts not found)."),
        );
        return;
      }
      ensureModelTool(root, context.extensionPath);
      store.refresh();
      vscode.window.showInformationMessage(t("AI-DLC panel initialized."));
    }),

    // Single button that manages workflow state: park when running, resume
    // (unpark) when parked. The agent's continuation itself happens in chat.
    vscode.commands.registerCommand("aidlcPanel.parkToggle", async () => {
      if (!root) {
        return;
      }
      const m = store.model;
      const parked = !!(m && m.ok && m.parked);
      const orchestrate = path.join(root, ".kiro", "tools", "aidlc-orchestrate.ts");
      const state = path.join(root, ".kiro", "tools", "aidlc-state.ts");
      if (parked) {
        const term = vscode.window.createTerminal({ cwd: root, name: "AI-DLC Resume" });
        term.show(true);
        term.sendText(`bun "${state}" unpark`);
        vscode.window.showInformationMessage(
          t("Workflow resumed (unpark). Continue with /aidlc in the Kiro chat."),
        );
      } else {
        const parkLabel = t("Park");
        const confirm = await vscode.window.showWarningMessage(
          t("Park the current workflow? It stops safely and can be resumed later."),
          { modal: true },
          parkLabel,
        );
        if (confirm !== parkLabel) {
          return;
        }
        const term = vscode.window.createTerminal({ cwd: root, name: "AI-DLC Park" });
        term.show(true);
        term.sendText(`bun "${orchestrate}" park --project-dir "${root}"`);
      }
      setTimeout(() => store.refresh(), 2500);
    }),

    vscode.commands.registerCommand("aidlcPanel.showStage", (arg: unknown) => {
      const stage = arg as StageModel | undefined;
      if (stage && typeof stage === "object" && "slug" in stage) {
        StageDetailPanel.show(stage);
      }
    }),

    vscode.commands.registerCommand("aidlcPanel.showTip", (arg: unknown) => {
      const tip = typeof arg === "string" ? findTip(arg) : undefined;
      if (tip) {
        TipDetailPanel.show(tip);
      }
    }),

    vscode.commands.registerCommand("aidlcPanel.openUrl", (arg: unknown) => {
      if (typeof arg === "string" && arg) {
        void vscode.env.openExternal(vscode.Uri.parse(arg));
      }
    }),

    vscode.commands.registerCommand(
      "aidlcPanel.openArtifact",
      async (arg: unknown) => {
        const abs = argToAbsPath(arg);
        if (!abs) {
          return;
        }
        const uri = vscode.Uri.file(abs);
        if (isQuestionsArtifact(abs)) {
          QuestionDetailPanel.show(abs);
          return;
        }
        // Markdown artifacts open directly in the rendered preview.
        if (abs.toLowerCase().endsWith(".md")) {
          try {
            await vscode.commands.executeCommand("markdown.showPreview", uri);
            return;
          } catch {
            /* fall through to plain open */
          }
        }
        await vscode.commands.executeCommand("vscode.open", uri);
      },
    ),

    // View mode for Q&A files: their default click opens the interactive answer
    // panel, so this offers a read-only rendered-markdown preview instead.
    vscode.commands.registerCommand(
      "aidlcPanel.viewArtifact",
      async (arg: unknown) => {
        const abs = argToAbsPath(arg);
        if (!abs) {
          return;
        }
        const uri = vscode.Uri.file(abs);
        try {
          await vscode.commands.executeCommand("markdown.showPreview", uri);
          return;
        } catch {
          /* fall through to plain open */
        }
        await vscode.commands.executeCommand("vscode.open", uri);
      },
    ),

    // Open an artifact in the raw text editor for editing. Default click keeps
    // the rendered markdown preview (aidlcPanel.openArtifact); this is the
    // explicit "edit mode" affordance, so it always opens the source, never the
    // preview — including for markdown.
    vscode.commands.registerCommand(
      "aidlcPanel.editArtifact",
      async (arg: unknown) => {
        const abs = argToAbsPath(arg);
        if (!abs) {
          return;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(abs), {
          preview: false,
        });
      },
    ),

    vscode.commands.registerCommand("aidlcPanel.diffArtifact", (arg: unknown) => {
      const abs = argToAbsPath(arg);
      if (!abs || !root) {
        return;
      }
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const check = cp.spawnSync(
        "git",
        ["-C", root, "cat-file", "-e", `HEAD:${rel}`],
        { encoding: "utf8" },
      );
      const fileUri = vscode.Uri.file(abs);
      const base = rel.split("/").pop() ?? rel;
      if (check.status !== 0) {
        vscode.window.showInformationMessage(
          t("{0}: new file not in git HEAD. Opening the file.", base),
        );
        vscode.commands.executeCommand("vscode.open", fileUri);
        return;
      }
      const headUri = vscode.Uri.from({ scheme: HEAD_SCHEME, path: "/" + rel });
      vscode.commands.executeCommand(
        "vscode.diff",
        headUri,
        fileUri,
        t("{0} (HEAD ↔ working copy)", base),
      );
    }),

    vscode.commands.registerCommand(
      "aidlcPanel.toggleReviewed",
      (arg: unknown) => {
        const abs = argToAbsPath(arg);
        if (!abs) {
          return;
        }
        const found = artifacts.findArtifact(abs);
        if (found) {
          void review.toggle(found.artifact.name);
        }
      },
    ),

    vscode.commands.registerCommand("aidlcPanel.runNextStage", async () => {
      const m = store.model;
      if (!m || !m.ok) {
        vscode.window.showInformationMessage(t("No active AI-DLC state."));
        return;
      }
      // Continue the workflow by handing the engine command straight to Kiro.
      // `/aidlc` resolves the active intent and resumes from the last
      // checkpoint on its own, so the submitted text (and the clipboard copy)
      // is exactly the command to run — no prose prompt to trim.
      await sendToKiro("/aidlc", undefined, { newSession: true });
    }),

    vscode.commands.registerCommand(
      "aidlcPanel.markReviewed",
      async (arg: unknown) => {
        const abs = argToAbsPath(arg);
        if (!abs) {
          return;
        }
        const found = artifacts.findArtifact(abs);
        if (found) {
          await artifacts.setReviewed(found.artifact, true);
        }
      },
    ),

    vscode.commands.registerCommand(
      "aidlcPanel.unmarkReviewed",
      async (arg: unknown) => {
        const abs = argToAbsPath(arg);
        if (!abs) {
          return;
        }
        const found = artifacts.findArtifact(abs);
        if (found) {
          await artifacts.setReviewed(found.artifact, false);
        }
      },
    ),

    vscode.commands.registerCommand("aidlcPanel.switchIntent", async () => {
      const model = store.model;
      if (!model || !root) {
        return;
      }
      const options = model.intents
        .filter((i) => i.dirName)
        .map((i) => ({
          label: `${i.active ? "● " : ""}${i.slug}`,
          description: [i.scope, i.status].filter(Boolean).join(" · "),
          dirName: i.dirName as string,
        }));
      if (options.length === 0) {
        vscode.window.showInformationMessage(t("No intents to switch to."));
        return;
      }
      const chosen = await vscode.window.showQuickPick(options, {
        placeHolder: t("Select the active intent"),
      });
      if (!chosen) {
        return;
      }
      const cursor = path.join(
        root,
        "aidlc",
        "spaces",
        model.space,
        "intents",
        "active-intent",
      );
      try {
        fs.mkdirSync(path.dirname(cursor), { recursive: true });
        fs.writeFileSync(cursor, chosen.dirName + "\n", "utf8");
        store.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(t("Failed to switch intent: {0}", message));
      }
    }),

    vscode.commands.registerCommand("aidlcPanel.askKiro", async () => {
      const m = store.model;
      if (!m || !m.ok) {
        vscode.window.showInformationMessage(t("No active AI-DLC state."));
        return;
      }
      const cur = (m.stages ?? []).find((s) => s.slug === m.currentStage);
      const prompt =
        t(
          'AI-DLC is in progress. The current stage is "{0}" ({1}), scope={2}, phase={3}.',
          m.currentStage ?? "",
          m.nextAction ?? "",
          m.scope ?? "",
          m.lifecyclePhase ?? "",
        ) + "\n" +
        (cur ? t("Purpose of this stage: {0}", cur.purpose) + "\n" : "") +
        t("Please help me carry out this stage.");
      await sendToKiro(prompt);
    }),

    vscode.commands.registerCommand(
      "aidlcPanel.askKiroArtifact",
      async (arg: unknown) => {
        const abs = argToAbsPath(arg);
        if (!abs || !root) {
          return;
        }
        const rel = path.relative(root, abs).split(path.sep).join("/");
        const base = rel.split("/").pop() ?? rel;
        const prompt =
          t("Please review the following AI-DLC artifact: {0}", rel) + "\n\n" +
          t("Summarize gaps against the requirements, risks, and improvements, and propose the necessary fixes.") + "\n" +
          t("(Target file #File: {0} — it is open in the editor.)", base);
        await sendToKiro(prompt, abs);
      },
    ),

    vscode.commands.registerCommand("aidlcPanel.probeChatCommands", async () => {
      const all = await vscode.commands.getCommands(true);
      const hits = all
        .filter((c) => /chat|kiro|agent|prompt|amazonq/i.test(c))
        .sort();
      const present = CHAT_COMMAND_CANDIDATES.filter((id) => all.includes(id));
      const newPresent = NEW_CHAT_COMMAND_CANDIDATES.filter((id) =>
        all.includes(id),
      );
      const none = t("(none)");
      const content =
        `# ${t("New-session candidate commands (present)")}\n${newPresent.join("\n") || none}\n\n` +
        `# ${t("Chat open/send candidate commands (present)")}\n${present.join("\n") || none}\n\n` +
        `# ${t("All chat|kiro|agent|prompt|amazonq matches ({0})", hits.length)}\n${hits.join("\n")}\n`;
      const doc = await vscode.workspace.openTextDocument({
        content,
        language: "markdown",
      });
      vscode.window.showTextDocument(doc);
    }),

    // Re-scan Kiro session logs for the usage view (the model refresh already
    // does this; this is the explicit button for the Token Usage view title).
    vscode.commands.registerCommand("aidlcPanel.refreshUsage", () =>
      usage.refresh(),
    ),

    // Turn token usage calculation on/off (default on). When off, no session
    // logs are scanned and all usage surfaces go blank. Persisted globally.
    vscode.commands.registerCommand("aidlcPanel.toggleUsageTracking", async () => {
      const next = !usage.enabled;
      await context.globalState.update(USAGE_ENABLED_KEY, next);
      usage.setEnabled(next);
      features.refresh();
      vscode.window.setStatusBarMessage(
        next
          ? t("$(eye) Token usage tracking on")
          : t("$(eye-closed) Token usage tracking off"),
        3000,
      );
    }),

    // Toggle the usage view between the active workspace and all workspaces
    // (a cross-project total). Persisted per workspace.
    vscode.commands.registerCommand("aidlcPanel.usageScopeGlobal", async () => {
      await context.workspaceState.update(USAGE_SCOPE_KEY, "global");
      await vscode.commands.executeCommand(
        "setContext",
        "aidlcPanel.usageGlobal",
        true,
      );
      usage.setScope("global");
    }),
    vscode.commands.registerCommand("aidlcPanel.usageScopeWorkspace", async () => {
      await context.workspaceState.update(USAGE_SCOPE_KEY, undefined);
      await vscode.commands.executeCommand(
        "setContext",
        "aidlcPanel.usageGlobal",
        false,
      );
      usage.setScope("workspace");
    }),

    // Filter the usage view by month (or all time). Choices are the months
    // present in the current scope's data.
    vscode.commands.registerCommand("aidlcPanel.usagePeriod", async () => {
      const u = usage.usage;
      const cur = usage.period;
      const dot = (v: string): string => (cur === v ? "● " : "");
      const items: { label: string; period: string }[] = [
        { label: `${dot("")}${t("All time")}`, period: "" },
        ...(u?.months ?? []).map((m) => ({ label: `${dot(m)}${m}`, period: m })),
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: t("Filter token usage by month"),
      });
      if (!pick) {
        return;
      }
      await context.workspaceState.update(
        USAGE_PERIOD_KEY,
        pick.period || undefined,
      );
      usage.setPeriod(pick.period);
    }),

    // Feasibility probe: report whether Kiro credit/token usage can be read for
    // this workspace, and a summary of what was found. Opens a markdown report.
    vscode.commands.registerCommand("aidlcPanel.probeTokenUsage", async () => {
      const rec = recordDirOf(store.model, root);
      const u = await loadUsage(root, rec, "workspace");
      const none = t("(none)");
      const lines: string[] = [];
      lines.push(`# ${t("Token usage probe")}`);
      lines.push("");
      lines.push(`- ${t("Sessions store")}: \`${u.sessionsRoot}\``);
      lines.push(`- ${t("Workspace")}: \`${root ?? none}\``);
      lines.push(
        `- ${t("Stage attribution (audit)")}: ${u.hasStageAttribution ? t("available") : t("unavailable")}`,
      );
      lines.push("");
      lines.push(
        `**${t("Matched sessions")}: ${u.sessions.length}** · ` +
          `**${t("Turns")}: ${u.turnCount}** · ` +
          `**${t("Total credits")}: ${fmtCredits(u.totalCredits)}**`,
      );
      lines.push("");
      if (u.sessions.length === 0) {
        lines.push(
          t(
            "No Kiro sessions matched this workspace. Token usage is read from ~/.kiro/sessions; open this project in Kiro and have a conversation to generate data.",
          ),
        );
      } else {
        lines.push(`## ${t("Sessions")}`);
        for (const s of u.sessions) {
          lines.push(
            `- **${s.title}** — ⚡ ${fmtCredits(s.totalCredits)} · ` +
              t("{0} turns", s.turns.length) +
              (s.modelId ? ` · ${s.modelId}` : "") +
              (s.latestContextPercent !== undefined
                ? ` · ${Math.round(s.latestContextPercent)}%`
                : ""),
          );
        }
        if (u.byIntent.size > 0) {
          lines.push("");
          lines.push(`## ${t("By intent")}`);
          const rows = [...u.byIntent.entries()].sort(
            (a, b) => b[1].credits - a[1].credits,
          );
          for (const [intent, agg] of rows) {
            const active = intent === u.activeIntent ? " ●" : "";
            lines.push(
              `- **${intent}**${active} — ⚡ ${fmtCredits(agg.credits)} · ${t("{0} turns", agg.turns)}`,
            );
          }
        }
        if (u.byStage.size > 0) {
          lines.push("");
          lines.push(
            `## ${t("By stage")}` +
              (u.activeIntent ? ` (${u.activeIntent})` : ""),
          );
          for (const [slug, agg] of u.byStage) {
            const stage = (store.model?.stages ?? []).find((s) => s.slug === slug);
            const name = stage ? `${stage.number} ${stage.name}` : slug;
            lines.push(
              `- **${name}** — ⚡ ${fmtCredits(agg.credits)} · ${t("{0} turns", agg.turns)}`,
            );
          }
        }
      }
      const doc = await vscode.workspace.openTextDocument({
        content: lines.join("\n") + "\n",
        language: "markdown",
      });
      vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand("aidlcPanel.openFullDashboard", () => {
      if (!root) {
        return;
      }
      const tool = path.join(root, ".kiro", "tools", "aidlc-dashboard.ts");
      const res = cp.spawnSync(
        "bun",
        [tool, "--project-dir", root],
        { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      );
      const dash = path.join(root, "aidlc", "dashboard.html");
      if (fs.existsSync(dash)) {
        vscode.env.openExternal(vscode.Uri.file(dash));
      } else {
        vscode.window.showErrorMessage(
          t(
            "Failed to generate dashboard: {0}",
            (res.stderr ?? "").trim() || t("no output"),
          ),
        );
      }
    }),
  );

  /* --------------------------- Live refresh ----------------------------- */

  store.refresh();
}

export function deactivate(): void {
  /* no-op */
}
