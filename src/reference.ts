import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { t } from "./i18n";
import { PanelStore } from "./model";

/**
 * Reference & history tree: surfaces the space-level knowledge the agent uses
 * (memory rule layers, codekb, team knowledge) and the record-level trail
 * (gate questions, stage diaries, audit shards). All read-only; leaves open
 * the underlying file. Paths are derived from the model + known layout, so no
 * engine coupling beyond the file locations.
 */

interface GroupDef {
  id: string;
  icon: string;
  scope: "space" | "intent";
}

const GROUPS: GroupDef[] = [
  { id: "memory", icon: "book", scope: "space" },
  { id: "codekb", icon: "database", scope: "space" },
  { id: "knowledge", icon: "library", scope: "space" },
  { id: "questions", icon: "comment-discussion", scope: "intent" },
  { id: "diaries", icon: "note", scope: "intent" },
  { id: "audit", icon: "history", scope: "intent" },
];

/** Localized label for a reference group, resolved at render time. */
function groupLabel(id: string): string {
  switch (id) {
    case "memory":
      return t("Rule memory (memory)");
    case "codekb":
      return t("Code knowledge (codekb)");
    case "knowledge":
      return t("Team knowledge (knowledge)");
    case "questions":
      return t("Q&A (questions)");
    case "diaries":
      return t("Diary (memory)");
    case "audit":
      return t("Activity history (audit)");
    default:
      return id;
  }
}

type RefNode =
  | { kind: "message"; text: string }
  | { kind: "group"; def: GroupDef }
  | { kind: "dir"; dir: string }
  | { kind: "file"; file: string; label?: string; desc?: string };

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Recursively collect files under root matching a predicate (skips dot-dirs). */
function collectFiles(
  root: string,
  match: (name: string) => boolean,
  depth = 6,
): string[] {
  const out: string[] = [];
  const walk = (dir: string, left: number): void => {
    if (left < 0) {
      return;
    }
    for (const entry of safeReaddir(dir)) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, left - 1);
      } else if (match(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root, depth);
  return out.sort();
}

/** Count unanswered [Answer]: tags in a questions file. */
function pendingAnswers(file: string): { pending: number; total: number } {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { pending: 0, total: 0 };
  }
  const lines = text.split(/\r?\n/);
  let total = 0;
  let pending = 0;
  for (const line of lines) {
    const m = line.match(/\[Answer\]:\s*(.*)$/);
    if (m) {
      total += 1;
      if (m[1].trim() === "") {
        pending += 1;
      }
    }
  }
  return { pending, total };
}

export class ReferenceProvider implements vscode.TreeDataProvider<RefNode> {
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._emitter.event;

  constructor(
    private readonly store: PanelStore,
    private root: string,
  ) {
    store.onDidChange(() => this._emitter.fire());
  }

  /** Retarget at a different AI-DLC workspace root and re-render. */
  setRoot(root: string): void {
    this.root = root;
    this._emitter.fire();
  }

  private spaceDir(): string | undefined {
    const m = this.store.model;
    if (!m) {
      return undefined;
    }
    return path.join(this.root, "aidlc", "spaces", m.space);
  }

  private recordDir(): string | undefined {
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
    );
  }

  private groupChildren(def: GroupDef): RefNode[] {
    const space = this.spaceDir();
    const record = this.recordDir();
    const dirChildren = (dir: string | undefined): RefNode[] => {
      if (!dir || !fs.existsSync(dir)) {
        return [{ kind: "message", text: t("(none)") }];
      }
      const nodes = this.readDir(dir);
      return nodes.length > 0
        ? nodes
        : [{ kind: "message", text: t("(empty)") }];
    };

    switch (def.id) {
      case "memory":
        return dirChildren(space ? path.join(space, "memory") : undefined);
      case "codekb":
        return dirChildren(space ? path.join(space, "codekb") : undefined);
      case "knowledge":
        return dirChildren(space ? path.join(space, "knowledge") : undefined);
      case "audit":
        return dirChildren(record ? path.join(record, "audit") : undefined);
      case "questions": {
        if (!record) {
          return [{ kind: "message", text: t("(none)") }];
        }
        const files = collectFiles(record, (n) => n.endsWith("-questions.md"));
        if (files.length === 0) {
          return [{ kind: "message", text: t("(no questions files)") }];
        }
        return files.map((file) => {
          const { pending, total } = pendingAnswers(file);
          return {
            kind: "file",
            file,
            label: path.basename(path.dirname(file)),
            desc:
              total === 0
                ? ""
                : pending > 0
                  ? t("{0}/{1} unanswered", pending, total)
                  : t("answered"),
          } as RefNode;
        });
      }
      case "diaries": {
        if (!record) {
          return [{ kind: "message", text: t("(none)") }];
        }
        const files = collectFiles(record, (n) => n === "memory.md");
        if (files.length === 0) {
          return [{ kind: "message", text: t("(no diaries)") }];
        }
        return files.map(
          (file) =>
            ({
              kind: "file",
              file,
              label: path.basename(path.dirname(file)),
            }) as RefNode,
        );
      }
      default:
        return [];
    }
  }

  private readDir(dir: string): RefNode[] {
    const entries = safeReaddir(dir).filter((e) => !e.name.startsWith("."));
    const dirs = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ kind: "dir", dir: path.join(dir, e.name) }) as RefNode);
    const files = entries
      .filter((e) => e.isFile())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ kind: "file", file: path.join(dir, e.name) }) as RefNode);
    return [...dirs, ...files];
  }

  getTreeItem(node: RefNode): vscode.TreeItem {
    if (node.kind === "message") {
      return new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    }
    if (node.kind === "group") {
      const item = new vscode.TreeItem(
        groupLabel(node.def.id),
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.iconPath = new vscode.ThemeIcon(node.def.icon);
      item.contextValue = "ref-group";
      item.description = node.def.scope === "space" ? "space" : "intent";
      return item;
    }
    if (node.kind === "dir") {
      const item = new vscode.TreeItem(
        path.basename(node.dir),
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.resourceUri = vscode.Uri.file(node.dir);
      item.contextValue = "ref-dir";
      return item;
    }
    const item = new vscode.TreeItem(
      node.label ?? path.basename(node.file),
      vscode.TreeItemCollapsibleState.None,
    );
    item.resourceUri = vscode.Uri.file(node.file);
    item.description = node.desc ?? "";
    item.tooltip = node.file;
    item.contextValue = "ref-file";
    item.command = {
      command: "aidlcPanel.openArtifact",
      title: t("Open"),
      arguments: [node.file],
    };
    return item;
  }

  getChildren(element?: RefNode): RefNode[] {
    const model = this.store.model;
    if (!model) {
      return [{ kind: "message", text: t("Loading…") }];
    }
    if (!element) {
      return GROUPS.map((def) => ({ kind: "group", def }));
    }
    if (element.kind === "group") {
      return this.groupChildren(element.def);
    }
    if (element.kind === "dir") {
      const nodes = this.readDir(element.dir);
      return nodes.length > 0
        ? nodes
        : [{ kind: "message", text: t("(empty)") }];
    }
    return [];
  }
}
