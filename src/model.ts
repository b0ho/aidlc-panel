import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { currentLang, t } from "./i18n";

export type StageStatus =
  | "completed"
  | "in-progress"
  | "awaiting-approval"
  | "revising"
  | "pending"
  | "skipped";

export interface ArtifactModel {
  name: string;
  absPath: string;
  /** Construction Bolt this artifact belongs to, or null/undefined when it is
   *  not nested under a Bolt. Drives per-Bolt grouping in the artifacts view. */
  bolt?: string | null;
}

export interface StageModel {
  slug: string;
  number: string;
  name: string;
  phase: string;
  status: StageStatus;
  purpose: string;
  leadAgent: string;
  supportAgents: string[];
  consumes: string[];
  produces: string[];
  condition: string;
  artifacts: ArtifactModel[];
  openQuestions?: number;
  totalQuestions?: number;
  questionsFile?: string | null;
}

export interface PhaseModel {
  phase: string;
  label: string;
  completed: number;
  total: number;
  percent: number;
  stages: StageModel[];
}

export interface IntentModel {
  dirName: string | null;
  slug: string;
  status: string;
  scope: string | null;
  active: boolean;
}

export interface PanelModel {
  ok: boolean;
  reason?: string;
  message?: string;
  projectDir?: string;
  space: string;
  intent?: string;
  intentSlug?: string;
  scope?: string;
  lifecyclePhase?: string;
  parked?: boolean;
  parkedAtStage?: string;
  currentStage?: string;
  nextStage?: string;
  nextAction?: string;
  pendingArtifacts?: string;
  overall?: {
    completed: number;
    total: number;
    remaining: number;
    percent: number;
  };
  phases?: PhaseModel[];
  stages?: StageModel[];
  intents: IntentModel[];
}

const MODEL_TOOL_REL = path.join(".kiro", "tools", "panel-model.ts");
const MODEL_TOOL_NAME = "panel-model.ts";
const ENGINE_LIB_REL = path.join(".kiro", "tools", "aidlc-lib.ts");

/** Whether an artifact (by name or absolute path) is a Q&A file. `*-questions.md`
 *  files are genuine produced artifacts, but the engine classifies them as
 *  non-prose. The panel lists them (Q&A-tagged, governed by the Q&A/diary
 *  visibility toggle) but excludes them from review counts — you answer them,
 *  you don't "review" them. Shared so every surface agrees. */
export function isQuestionsArtifact(nameOrPath: string): boolean {
  return nameOrPath.endsWith("-questions.md");
}

/**
 * Locate the AI-DLC workspace root: the open folder that has the engine library
 * (`.kiro/tools/aidlc-lib.ts`). Detection is on the ENGINE, not our addon tool,
 * so the panel works in any AI-DLC workspace — the model tool is installed on
 * demand (see ensureModelTool). In a multi-root workspace the engine lives in
 * one folder.
 */
export function findAidlcRoot(): string | undefined {
  return findAidlcRoots()[0];
}

/**
 * List every open workspace folder that hosts an AI-DLC engine
 * (`.kiro/tools/aidlc-lib.ts`), preserving workspace-folder order. In a
 * multi-root workspace with several AI-DLC projects (e.g. multiple repos under
 * one parent) this returns all of them so the panel can target the one the user
 * is actually working in, instead of being pinned to the first folder.
 */
export function findAidlcRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const out: string[] = [];
  for (const folder of folders) {
    if (fs.existsSync(path.join(folder.uri.fsPath, ENGINE_LIB_REL))) {
      out.push(folder.uri.fsPath);
    }
  }
  return out;
}

/**
 * Install (or refresh) the addon model tool into the workspace's .kiro/tools so
 * it sits next to aidlc-lib.ts (which it imports). Copies from the extension's
 * bundled copy. Returns true if the tool is present/installed afterwards.
 */
export function ensureModelTool(root: string, extensionPath: string): boolean {
  const target = path.join(root, MODEL_TOOL_REL);
  const bundled = path.join(extensionPath, "tools", MODEL_TOOL_NAME);
  const toolsDir = path.join(root, ".kiro", "tools");
  try {
    // Remove any legacy model tool from earlier builds. Older versions shipped
    // this as `cns-panel-model.ts`; delete every `*panel-model.ts` that is not
    // the current name so only `panel-model.ts` remains in .kiro/tools.
    if (fs.existsSync(toolsDir)) {
      for (const entry of fs.readdirSync(toolsDir)) {
        if (/panel-model\.ts$/.test(entry) && entry !== MODEL_TOOL_NAME) {
          try {
            fs.unlinkSync(path.join(toolsDir, entry));
          } catch {
            /* best effort */
          }
        }
      }
    }
    if (!fs.existsSync(bundled)) {
      return fs.existsSync(target);
    }
    const src = fs.readFileSync(bundled, "utf8");
    const cur = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (src !== cur) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, src, "utf8");
    }
    return true;
  } catch {
    return fs.existsSync(target);
  }
}

function spawnErrorModel(err: unknown): PanelModel {
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    reason: "spawn-error",
    message: t("Failed to load the model: {0}", message),
    space: "default",
    intents: [],
  };
}

/**
 * Run the read-only addon model tool via bun and parse its JSON. Async and
 * non-blocking: spawns bun (no shell — bun/git are `.exe`, so PATH resolves and
 * paths need no quoting) and resolves when it exits. Never rejects; on any
 * failure resolves an ok:false model so the UI can render a message.
 */
export function loadModel(root: string | undefined): Promise<PanelModel> {
  if (!root) {
    return Promise.resolve({
      ok: false,
      reason: "no-workspace",
      message: t("Not an AI-DLC workspace (.kiro/tools/aidlc-lib.ts not found)."),
      space: "default",
      intents: [],
    });
  }
  const toolPath = path.join(root, MODEL_TOOL_REL);
  // Pass the effective panel language so the tool localizes the stage purposes
  // and next-action phrasing it emits (English base, Korean when selected).
  return new Promise((resolve) => {
    let child: cp.ChildProcessWithoutNullStreams;
    try {
      child = cp.spawn(
        "bun",
        [toolPath, "--json", "--lang", currentLang(), "--project-dir", root],
        { cwd: root },
      );
    } catch (err) {
      resolve(spawnErrorModel(err));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => resolve(spawnErrorModel(err)));
    child.on("close", () => {
      const out = stdout.trim();
      if (!out) {
        resolve({
          ok: false,
          reason: "no-output",
          message:
            stderr.trim() ||
            t("The model tool returned no output. Check that bun is on your PATH."),
          space: "default",
          intents: [],
        });
        return;
      }
      try {
        const parsed = JSON.parse(out) as PanelModel;
        if (!Array.isArray(parsed.intents)) {
          parsed.intents = [];
        }
        resolve(parsed);
      } catch (err) {
        resolve(spawnErrorModel(err));
      }
    });
  });
}

/**
 * Shared state store. Holds the latest model and notifies views on refresh.
 * refresh() is fire-and-forget: it kicks off an async model load and fires
 * onDidChange when the result arrives. A monotonic sequence token drops
 * out-of-order results so a slow older load can't overwrite a newer one.
 */
export class PanelStore {
  private _model: PanelModel | undefined;
  private _seq = 0;
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this._emitter.event;

  constructor(private _root: string | undefined) {}

  get root(): string | undefined {
    return this._root;
  }

  /** Retarget the store at a different AI-DLC workspace root and reload. No-op
   *  when the root is unchanged, so redundant active-editor events are cheap. */
  setRoot(root: string | undefined): void {
    if (root === this._root) {
      return;
    }
    this._root = root;
    this._model = undefined;
    this.refresh();
  }

  get model(): PanelModel | undefined {
    return this._model;
  }

  refresh(): void {
    const seq = ++this._seq;
    void loadModel(this._root).then((model) => {
      if (seq !== this._seq) {
        return; // a newer refresh already superseded this one
      }
      this._model = model;
      this._emitter.fire();
    });
  }
}
