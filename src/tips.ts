import * as vscode from "vscode";
import { t } from "./i18n";

/** A rich help topic rendered in the TipDetailPanel when clicked. */
export interface TipItem {
  id: string;
  title: string;
  subtitle?: string;
  icon: string; // ThemeIcon id for the tree row
  diagram?: "lifecycle" | "intentLoop" | "gate";
  sections: { heading: string; html: string }[];
  links?: { label: string; url: string }[];
}

interface TipCategory {
  id: string;
  label: string;
  icon: string;
  items: TipItem[];
}

// Official AI-DLC v2 documentation (awslabs/aidlc-workflows, v2 branch).
const GUIDE_URL = "https://awslabs.github.io/aidlc-workflows/";
const GUIDE_PHASES_URL =
  "https://awslabs.github.io/aidlc-workflows/guide/04-phases-and-stages/";
const GUIDE_SCOPE_URL =
  "https://awslabs.github.io/aidlc-workflows/guide/05-scopes-and-depth/";

// Curated, paraphrased from the official AI-DLC v2 guide + AGENTS.md. Kept short
// and practical; the full guide is linked from each relevant topic. Built as a
// function so t() resolves against the active display language.
function tipCategories(): TipCategory[] {
  return [
    {
      id: "overview",
      label: t("AI-DLC Overview"),
      icon: "book",
      items: [
        {
          id: "what",
          title: t("What is AI-DLC?"),
          subtitle: t("A structured AI development methodology"),
          icon: "lightbulb",
          sections: [
            {
              heading: t("What it is"),
              html: t(
                "An AI-driven development methodology where multiple specialist agents handle the whole lifecycle — from planning to operation — through defined stages. Unlike plain AI coding, every decision has a human approval gate.",
              ),
            },
            {
              heading: t("Why use it"),
              html: t(
                "It prevents the lost context, vanished rationale, and silent failures that appear as a project grows, using per-stage ownership, gate verification, and an audit log.",
              ),
            },
          ],
          links: [{ label: t("Official guide · Overview"), url: GUIDE_URL }],
        },
        {
          id: "phases",
          title: t("5-phase structure"),
          subtitle: "Initialization → Operation",
          icon: "layers",
          diagram: "lifecycle",
          sections: [
            {
              heading: t("Flow"),
              html: t(
                "It starts with Initialization (automatic), then proceeds through Ideation, Inception, Construction, and Operation. There is a verification gate between phases.",
              ),
            },
            {
              heading: t("Note"),
              html: t(
                "The flow chart is a <b>catalog of possible stages</b>. A project is not run through all 32 stages at once; it is split by intent and executed iteratively.",
              ),
            },
          ],
          links: [
            {
              label: t("Official guide · Phases and stages"),
              url: GUIDE_PHASES_URL,
            },
          ],
        },
        {
          id: "principles",
          title: t("Core principles"),
          subtitle: t("Gates · Audit · Learning"),
          icon: "verified",
          sections: [
            {
              heading: t("Gate-based control"),
              html: t(
                "Every stage except Initialization will not move on without human approval.",
              ),
            },
            {
              heading: t("Document-first audit"),
              html: t(
                "Even if the code disappears, the rationale and artifacts remain. History is traced through the audit log.",
              ),
            },
            {
              heading: t("Self-learning loop"),
              html: t(
                "When a human corrects a result, that correction is accumulated as a permanent rule in Space memory.",
              ),
            },
          ],
        },
        {
          id: "intentLoop",
          title: t("Iterative execution per intent"),
          subtitle: t("Real-world usage pattern"),
          icon: "sync",
          diagram: "intentLoop",
          sections: [
            {
              heading: t("Pattern"),
              html: t(
                "The first intent establishes the architecture; later intents get progressively faster as accumulated Space memory lets conditional stages auto-skip.",
              ),
            },
          ],
        },
      ],
    },
    {
      id: "scope",
      label: t("Scope & Depth"),
      icon: "target",
      items: [
        {
          id: "scopeWhat",
          title: t("What is Scope"),
          subtitle: t("Decides which stages run and how deep"),
          icon: "target",
          sections: [
            {
              heading: t("Concept"),
              html: t(
                "Scope decides which stages run in an intent, and how deeply. Set it with <code>/aidlc --scope &lt;name&gt;</code>; if omitted it is auto-detected.",
              ),
            },
          ],
          links: [
            { label: t("Official guide · Scope & Depth"), url: GUIDE_SCOPE_URL },
          ],
        },
        {
          id: "scopeCompare",
          title: t("Comparing key scopes"),
          subtitle: "bugfix ~ enterprise",
          icon: "list-tree",
          sections: [
            {
              heading: t("Quick selection guide"),
              html: `<table class="cmp">
                <tr><th>${t("Scope")}</th><th>${t("Use")}</th></tr>
                <tr><td><code>bugfix</code></td><td>${t("Bug fix — fastest path (skips Ideation)")}</td></tr>
                <tr><td><code>security-patch</code></td><td>${t("CVE / security patch response")}</td></tr>
                <tr><td><code>poc</code></td><td>${t("Proof of concept — minimal stages")}</td></tr>
                <tr><td><code>mvp</code></td><td>${t("Build core only, exclude Operation")}</td></tr>
                <tr><td><code>feature</code></td><td>${t("Default for new features (practical depth)")}</td></tr>
                <tr><td><code>enterprise</code></td><td>${t("All stages — for establishing the foundation")}</td></tr>
              </table>`,
            },
            {
              heading: t("Custom composition"),
              html: t(
                'If a stock scope does not fit, use <code>/aidlc compose "&lt;task&gt;"</code> to get an EXECUTE/SKIP grid proposal, then run it after approval.',
              ),
            },
          ],
        },
        {
          id: "depth",
          title: t("Depth · Test strategy"),
          subtitle: "depth / test-strategy",
          icon: "settings-gear",
          sections: [
            {
              heading: t("Artifact depth"),
              html: t(
                "Use <code>/aidlc --depth minimal|standard|comprehensive</code> to adjust the detail of documents and questions.",
              ),
            },
            {
              heading: t("Test volume"),
              html: t(
                "Use <code>/aidlc --test-strategy &lt;level&gt;</code> to control test coverage separately.",
              ),
            },
          ],
        },
      ],
    },
    {
      id: "start",
      label: t("Start & Commands"),
      icon: "rocket",
      items: [
        {
          id: "kick",
          title: t("Start · Status · Check"),
          subtitle: t("The first commands to use"),
          icon: "play",
          sections: [
            {
              heading: t("Start"),
              html: t(
                "Start by describing what to build after <code>/aidlc</code>, or with <code>/aidlc --scope feature</code>.",
              ),
            },
            {
              heading: t("Status · Check"),
              html: t(
                "Progress: <code>/aidlc --status</code>, setup check: <code>/aidlc --doctor</code>, version: <code>/aidlc --version</code>.",
              ),
            },
          ],
        },
        {
          id: "gate",
          title: t("Responding to gates"),
          subtitle: t("Approve · Revise · Reject"),
          icon: "law",
          diagram: "gate",
          sections: [
            {
              heading: t("How"),
              html: t(
                "At the end of each stage, choose approve/revise/reject. The <code>[Answer]:</code> tags in the questions file are the source of truth.",
              ),
            },
          ],
        },
        {
          id: "jump",
          title: t("Stage · Phase jump"),
          subtitle: t("Partial execution"),
          icon: "debug-step-over",
          sections: [
            {
              heading: t("Jump"),
              html: t(
                "Jump to a stage with <code>/aidlc --stage &lt;slug&gt;</code>, to a phase with <code>/aidlc --phase &lt;name&gt;</code>. Add <code>--single</code> to run it standalone.",
              ),
            },
          ],
        },
        {
          id: "session",
          title: t("Pause · Retrospective tools"),
          subtitle: "park · replay · outcomes",
          icon: "history",
          sections: [
            {
              heading: t("Pause · Resume"),
              html: t(
                "Use the park button in the Actions view, or <code>park</code>/<code>unpark</code>. Artifacts are version-controlled under <code>aidlc/spaces/&lt;space&gt;/intents/&lt;intent&gt;/</code>.",
              ),
            },
            {
              heading: t("Retrospective · Wrap-up"),
              html: t(
                "<code>/aidlc-replay</code> (session summary), <code>/aidlc-session-cost</code> (cost), <code>/aidlc-outcomes-pack</code> (handover document).",
              ),
            },
          ],
        },
      ],
    },
    {
      id: "ext",
      label: t("Using the extension"),
      icon: "extensions",
      items: [
        {
          id: "views",
          title: t("Panel views"),
          subtitle: t("Overview · Actions · Stages · Artifacts · Reference"),
          icon: "window",
          sections: [
            {
              heading: t("Overview"),
              html: t(
                "Progress, review status, and the next task at a glance.",
              ),
            },
            {
              heading: t("Actions"),
              html: t(
                "The Actions view gathers the workflow buttons — continue workflow, ask Kiro, switch intent, park/resume, open dashboard, refresh.",
              ),
            },
            {
              heading: t("Stages"),
              html: t(
                "Click a stage to open its details (what to check / goal / artifact review / execution-history timeline). Use the collapse toggles for completed and skipped stages to tidy up.",
              ),
            },
            {
              heading: t("Artifacts & Review"),
              html: t(
                "Provides changed/new badges, a reviewed checkmark, an edit-mode open icon, git change comparison, and Ask-Kiro review requests.",
              ),
            },
          ],
        },
        {
          id: "review",
          title: t("Review · Next stage"),
          subtitle: t("Clipboard flow"),
          icon: "comment-discussion",
          sections: [
            {
              heading: t("Review request / Continue workflow"),
              html: t(
                "Opens a new Kiro session and <b>copies the prompt to the clipboard</b>. Paste it into the chat (Ctrl+V) and run. (Kiro has no reliable API to inject chat input, so the copy approach is the most dependable.)",
              ),
            },
            {
              heading: t("Awaiting-approval notification"),
              html: t(
                'When a gate is reached, a status-bar notification appears. Use "Open stage" to jump straight to it.',
              ),
            },
          ],
        },
      ],
    },
  ];
}

/* ------------------------------- Tree view ------------------------------- */

type TipNode =
  | { kind: "category"; category: TipCategory }
  | { kind: "item"; item: TipItem }
  | { kind: "link"; label: string; url: string };

export class TipsProvider implements vscode.TreeDataProvider<TipNode> {
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._emitter.event;

  /** Re-render the tree (used on language change). */
  refresh(): void {
    this._emitter.fire();
  }

  getTreeItem(node: TipNode): vscode.TreeItem {
    if (node.kind === "link") {
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon("link-external");
      item.command = {
        command: "aidlcPanel.openUrl",
        title: t("Open"),
        arguments: [node.url],
      };
      return item;
    }
    if (node.kind === "category") {
      const item = new vscode.TreeItem(
        node.category.label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon(node.category.icon);
      item.contextValue = "tip-category";
      return item;
    }
    const item = new vscode.TreeItem(
      node.item.title,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.item.subtitle;
    item.tooltip = node.item.subtitle;
    item.iconPath = new vscode.ThemeIcon(node.item.icon);
    item.contextValue = "tip-item";
    item.command = {
      command: "aidlcPanel.showTip",
      title: t("Show Help"),
      arguments: [node.item.id],
    };
    return item;
  }

  getChildren(element?: TipNode): TipNode[] {
    if (!element) {
      const cats: TipNode[] = tipCategories().map((category) => ({
        kind: "category",
        category,
      }));
      cats.push({
        kind: "link",
        label: t("Open the official AI-DLC guide"),
        url: GUIDE_URL,
      });
      return cats;
    }
    if (element.kind === "category") {
      return element.category.items.map((item) => ({ kind: "item", item }));
    }
    return [];
  }
}

/** Find a tip by id (used by the showTip command). */
export function findTip(id: string): TipItem | undefined {
  for (const cat of tipCategories()) {
    const hit = cat.items.find((i) => i.id === id);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}
