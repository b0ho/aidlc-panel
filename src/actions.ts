import * as vscode from "vscode";
import { CustomAction, getCustomActions } from "./customActions";
import { languagePref, onDidChangeLanguage, t } from "./i18n";
import { findAidlcRoots, PanelStore } from "./model";

/** Short label for the current language preference, shown on the switch row. */
function langLabel(): string {
  switch (languagePref()) {
    case "en":
      return "English";
    case "ko":
      return "한국어";
    default:
      return t("Auto");
  }
}

/**
 * The Actions panel is split into two sibling views:
 *  - "tasks":   rows that hand a prompt to a Kiro session (Continue workflow,
 *               Ask Kiro) plus the user's custom actions and the "add" row.
 *  - "features": panel utilities that don't go to a Kiro session (switch
 *               intent, park/resume, dashboard, switch workspace, language,
 *               refresh).
 * One provider class serves both; the category is fixed per instance.
 */
export type ActionCategory = "tasks" | "features";

interface ActionDef {
  command: string;
  label: string;
  icon: string;
  tooltip?: string;
  /** Right-aligned grey text (e.g. the current intent/workspace selection). */
  description?: string;
  category: ActionCategory;
}

type ActionNode =
  | { kind: "action"; def: ActionDef }
  | { kind: "custom"; action: CustomAction }
  | { kind: "add-custom" };

export class ActionsProvider implements vscode.TreeDataProvider<ActionNode> {
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._emitter.event;

  constructor(
    private readonly store: PanelStore,
    private readonly category: ActionCategory,
    private readonly usageEnabled?: () => boolean,
  ) {
    store.onDidChange(() => this._emitter.fire());
    onDidChangeLanguage(() => this._emitter.fire());
    // The workspace-switch row (a feature) appears only in multi-root setups,
    // so re-render when folders are added or removed.
    vscode.workspace.onDidChangeWorkspaceFolders(() => this._emitter.fire());
    // Re-render when the user adds/edits/removes custom actions (from our
    // guided flow or by hand in settings).
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aidlcPanel.customActions")) {
        this._emitter.fire();
      }
    });
  }

  private allActions(): ActionDef[] {
    const parked = !!(this.store.model && this.store.model.ok && this.store.model.parked);
    // Only offer the workspace switcher when more than one AI-DLC project is
    // open; with a single workspace there is nothing to switch to.
    const multiRoot = findAidlcRoots().length > 1;
    const defs: ActionDef[] = [
      {
        command: "aidlcPanel.runNextStage",
        label: t("Continue workflow"),
        icon: "run",
        tooltip: t("Open a new Kiro session with a prompt to continue the workflow"),
        category: "tasks",
      },
      {
        command: "aidlcPanel.askKiro",
        label: t("Ask Kiro"),
        icon: "comment-discussion",
        tooltip: t("Ask Kiro for help with the current stage"),
        category: "tasks",
      },
      {
        command: "aidlcPanel.switchIntent",
        label: t("Switch intent"),
        icon: "list-selection",
        description:
          this.store.model?.intents.find((i) => i.active)?.slug ??
          this.store.model?.intentSlug ??
          this.store.model?.intent ??
          undefined,
        category: "features",
      },
      {
        command: "aidlcPanel.parkToggle",
        label: parked ? t("Resume workflow") : t("Park workflow"),
        icon: parked ? "debug-continue" : "debug-pause",
        category: "features",
      },
      {
        command: "aidlcPanel.openFullDashboard",
        label: t("Open full dashboard"),
        icon: "browser",
        category: "features",
      },
      ...(multiRoot
        ? [
            {
              command: "aidlcPanel.selectWorkspace",
              label: t("Switch workspace"),
              icon: "root-folder",
              tooltip: t("Choose which open AI-DLC project the panel targets"),
              description: (this.store.root ?? "").split("/").filter(Boolean).pop(),
              category: "features" as const,
            },
          ]
        : []),
      {
        command: "aidlcPanel.setLanguage",
        label: t("Language: {0}", langLabel()),
        icon: "globe",
        tooltip: t("Switch the panel language (English / 한국어 / auto)"),
        category: "features",
      },
      {
        command: "aidlcPanel.toggleUsageTracking",
        label: t(
          "Token usage tracking: {0}",
          this.usageEnabled?.() === false ? t("Off") : t("On"),
        ),
        icon: this.usageEnabled?.() === false ? "eye-closed" : "eye",
        tooltip: t(
          "Turn token usage calculation on or off. When off, no session logs are scanned.",
        ),
        category: "features",
      },
      {
        command: "aidlcPanel.refresh",
        label: t("Refresh"),
        icon: "refresh",
        category: "features",
      },
    ];
    return defs.filter((d) => d.category === this.category);
  }

  /** Re-render the rows (e.g. after toggling usage tracking). */
  refresh(): void {
    this._emitter.fire();
  }

  getTreeItem(node: ActionNode): vscode.TreeItem {
    if (node.kind === "custom") {
      const a = node.action;
      const item = new vscode.TreeItem(
        a.label,
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon("zap");
      item.description = a.newSession ? t("new session") : t("current session");
      // Tooltip previews the prompt so users can tell rows apart at a glance.
      const preview =
        a.prompt.length > 300 ? a.prompt.slice(0, 300) + "…" : a.prompt;
      item.tooltip = preview;
      item.command = {
        command: "aidlcPanel.runCustomAction",
        title: a.label,
        arguments: [a.id],
      };
      item.contextValue = "custom-action";
      return item;
    }

    if (node.kind === "add-custom") {
      const item = new vscode.TreeItem(
        t("Add custom action…"),
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon("add");
      item.tooltip = t("Create a labelled action that copies a prompt to Kiro");
      item.command = {
        command: "aidlcPanel.addCustomAction",
        title: t("Add custom action…"),
      };
      item.contextValue = "custom-action-add";
      return item;
    }

    const item = new vscode.TreeItem(
      node.def.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon(node.def.icon);
    if (node.def.description) {
      item.description = node.def.description;
    }
    item.tooltip = node.def.tooltip ?? node.def.label;
    item.command = {
      command: node.def.command,
      title: node.def.label,
    };
    item.contextValue = "action";
    return item;
  }

  getChildren(): ActionNode[] {
    const builtin: ActionNode[] = this.allActions().map((def) => ({
      kind: "action",
      def,
    }));
    if (this.category !== "tasks") {
      return builtin;
    }
    // The "tasks" view also carries custom actions and the add row.
    const custom: ActionNode[] = getCustomActions().map((action) => ({
      kind: "custom",
      action,
    }));
    return [...builtin, ...custom, { kind: "add-custom" }];
  }
}
