import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";

export type ChangeState = "new" | "changed" | undefined;

/**
 * Tracks which working-tree files differ from git HEAD, so artifacts can show a
 * "변경됨 / 신규" badge. Runs a single `git status --porcelain` per refresh
 * (async, no shell — git is a `.exe`, so PATH resolves and the root path needs
 * no quoting/escaping). Answers lookups from the parsed set and fires
 * onDidChange when a refresh completes so views can re-render. Non-fatal on any
 * git error — everything resolves to `undefined` (no badge).
 */
export class GitStatus {
  private changed = new Set<string>();
  private added = new Set<string>();
  private readonly _emitter = new vscode.EventEmitter<void>();
  /** Fires after a refresh completes (badge sets may have changed). */
  readonly onDidChange = this._emitter.event;

  constructor(private root: string | undefined) {}

  /** Retarget at a different repository root. The next refresh() reads its
   *  working tree; call refresh() after switching. */
  setRoot(root: string | undefined): void {
    this.root = root;
  }

  /** Re-read git status asynchronously. Call on each model refresh. The parsed
   *  sets are swapped in atomically on completion, so lookups never see a
   *  half-cleared state mid-refresh. */
  refresh(): void {
    if (!this.root) {
      this.changed = new Set();
      this.added = new Set();
      this._emitter.fire();
      return;
    }
    let child: cp.ChildProcessWithoutNullStreams;
    try {
      child = cp.spawn("git", ["-C", this.root, "status", "--porcelain"], {});
    } catch {
      this._emitter.fire();
      return;
    }
    const root = this.root;
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => this._emitter.fire());
    child.on("close", (code) => {
      const nextChanged = new Set<string>();
      const nextAdded = new Set<string>();
      if (code === 0 && stdout) {
        for (const raw of stdout.split(/\r?\n/)) {
          if (!raw.trim()) {
            continue;
          }
          // Porcelain v1: "XY <path>" (rename: "XY orig -> new").
          const codeXY = raw.slice(0, 2);
          let file = raw.slice(3).trim();
          const arrow = file.indexOf(" -> ");
          if (arrow >= 0) {
            file = file.slice(arrow + 4);
          }
          file = file.replace(/^"|"$/g, "");
          const abs = path.resolve(root, file);
          if (codeXY.includes("?")) {
            nextAdded.add(abs);
          } else {
            nextChanged.add(abs);
          }
        }
      }
      this.changed = nextChanged;
      this.added = nextAdded;
      this._emitter.fire();
    });
  }

  state(absPath: string): ChangeState {
    const abs = path.resolve(absPath);
    if (this.added.has(abs)) {
      return "new";
    }
    if (this.changed.has(abs)) {
      return "changed";
    }
    return undefined;
  }
}
