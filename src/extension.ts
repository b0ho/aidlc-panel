import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ActionsProvider } from "./actions";
import { readStageEvents } from "./audit";
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
  findAidlcRoot,
  isQuestionsArtifact,
  PanelStore,
  StageModel,
} from "./model";
import { OverviewViewProvider } from "./overviewView";
import { QuestionDetailPanel } from "./questionDetail";
import { ReferenceProvider } from "./reference";
import { ReviewState } from "./review";
import { StageDetailPanel } from "./stageDetail";
import { TipDetailPanel } from "./tipDetail";
import { findTip, TipsProvider } from "./tips";
import { ArtifactsProvider, ProgressProvider } from "./trees";

const HEAD_SCHEME = "aidlc-panel-head";

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

  // Best-effort: open/submit the request if a command honours a query argument.
  const present = CHAT_COMMAND_CANDIDATES.filter((id) => all.includes(id));
  const shapes = (p: string): unknown[] => [
    { query: p },
    { prompt: p },
    { message: p },
    { text: p },
    p,
  ];
  let opened = false;
  outer: for (const id of present) {
    for (const arg of shapes(prompt)) {
      try {
        await vscode.commands.executeCommand(id, arg);
        opened = true;
        break outer;
      } catch {
        /* try next shape */
      }
    }
  }
  if (!opened) {
    for (const id of present) {
      try {
        await vscode.commands.executeCommand(id);
        break;
      } catch {
        /* ignore */
      }
    }
  }

  // Kiro exposes no reliable public API to inject text into the chat input, so
  // query-submit is best-effort and silently no-ops on many builds. Guarantee
  // usability by putting the prompt on the clipboard for a one-key paste.
  let copied = false;
  try {
    await vscode.env.clipboard.writeText(prompt);
    copied = true;
  } catch {
    /* clipboard unavailable */
  }

  const where = freshSession
    ? t("a new Kiro session")
    : t("Kiro chat");
  if (copied) {
    void vscode.window.showInformationMessage(
      t(
        "Opened {0} and copied the prompt to the clipboard. Paste it into the chat (Ctrl+V) and run.",
        where,
      ),
    );
  } else {
    vscode.window.setStatusBarMessage(
      contextFile
        ? t("$(comment-discussion) Opened the file as context in {0}.", where)
        : t("$(comment-discussion) Opened {0}.", where),
      4000,
    );
  }
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

  const root = findAidlcRoot();
  // Install the read-only model tool into the workspace's .kiro/tools so it
  // sits beside aidlc-lib.ts (which it imports). Runs on every AI-DLC
  // workspace, so the panel works in new windows without manual setup.
  if (root) {
    ensureModelTool(root, context.extensionPath);
  }

  const store = new PanelStore(root);
  const review = new ReviewState(context.workspaceState, store);
  const git = new GitStatus(root);
  const overview = new OverviewViewProvider(store, review);
  const progress = new ProgressProvider(store, context.workspaceState);
  const artifacts = new ArtifactsProvider(
    store,
    context.workspaceState,
    review,
    git,
    root ?? "",
  );
  const reference = new ReferenceProvider(store, root ?? "");
  const tips = new TipsProvider();
  const actions = new ActionsProvider(store);
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
    StageDetailPanel.refresh();
    updateStatusUi();
  });
  review.onDidChange(() => StageDetailPanel.refresh());
  // git status resolves asynchronously; refresh the stage-detail change badges
  // when it lands (the artifacts tree subscribes to git directly).
  git.onDidChange(() => StageDetailPanel.refresh());

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
    };
  });

  // Tree views are created (not just registered) so their section titles can be
  // relabelled live when the panel language switches.
  const actionsView = vscode.window.createTreeView("aidlcPanelActions", {
    treeDataProvider: actions,
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
  const setViewTitles = (): void => {
    actionsView.title = t("Actions");
    progressView.title = t("Stages");
    artifactsView.title = t("Artifacts & Review");
    referenceView.title = t("Reference & History");
    tipsView.title = t("Tips & Help");
    overview.setTitle(t("Overview"));
  };
  setViewTitles();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("aidlcPanelOverview", overview),
    actionsView,
    progressView,
    artifactsView,
    referenceView,
    tipsView,
  );

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

  if (root) {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = (): void => {
      if (debounce) {
        clearTimeout(debounce);
      }
      debounce = setTimeout(() => store.refresh(), 300);
    };
    const watcher = vscode.workspace.createFileSystemWatcher(
      // Watch state + cursor files AND `*-questions.md` Q&A files: entering a
      // human turn (agent asks the user questions) writes/updates a questions
      // file without necessarily touching aidlc-state.md, so without this the
      // status bar never refreshes and the one-shot "awaiting answers"
      // notification never fires.
      new vscode.RelativePattern(root, "aidlc/**/{aidlc-state.md,active-intent,*-questions.md}"),
    );
    const spaceWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, "aidlc/active-space"),
    );
    for (const w of [watcher, spaceWatcher]) {
      w.onDidChange(scheduleRefresh);
      w.onDidCreate(scheduleRefresh);
      w.onDidDelete(scheduleRefresh);
      context.subscriptions.push(w);
    }
  }

  store.refresh();
}

export function deactivate(): void {
  /* no-op */
}
