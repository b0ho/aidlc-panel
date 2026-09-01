import * as vscode from "vscode";
import { languagePref, onDidChangeLanguage, t } from "./i18n";
import { PanelStore } from "./model";

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
 * A dedicated "Actions" view that gathers the workflow action buttons into one
 * group (a sibling section to Overview / Stages), instead of scattering them
 * across other views' title toolbars. Each row runs a command; the park/resume
 * row relabels itself from the current model.
 */
interface ActionDef {
  command: string;
  label: string;
  icon: string;
  tooltip?: string;
}

type ActionNode = { kind: "action"; def: ActionDef };

export class ActionsProvider implements vscode.TreeDataProvider<ActionNode> {
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._emitter.event;

  constructor(private readonly store: PanelStore) {
    store.onDidChange(() => this._emitter.fire());
    onDidChangeLanguage(() => this._emitter.fire());
  }

  private actions(): ActionDef[] {
    const parked = !!(this.store.model && this.store.model.ok && this.store.model.parked);
    return [
      {
        command: "aidlcPanel.runNextStage",
        label: t("Continue workflow"),
        icon: "run",
        tooltip: t("Open a new Kiro session with a prompt to continue the workflow"),
      },
      {
        command: "aidlcPanel.askKiro",
        label: t("Ask Kiro"),
        icon: "comment-discussion",
        tooltip: t("Ask Kiro for help with the current stage"),
      },
      {
        command: "aidlcPanel.switchIntent",
        label: t("Switch intent"),
        icon: "list-selection",
      },
      {
        command: "aidlcPanel.parkToggle",
        label: parked ? t("Resume workflow") : t("Park workflow"),
        icon: parked ? "debug-continue" : "debug-pause",
      },
      {
        command: "aidlcPanel.openFullDashboard",
        label: t("Open full dashboard"),
        icon: "browser",
      },
      {
        command: "aidlcPanel.setLanguage",
        label: t("Language: {0}", langLabel()),
        icon: "globe",
        tooltip: t("Switch the panel language (English / 한국어 / auto)"),
      },
      {
        command: "aidlcPanel.refresh",
        label: t("Refresh"),
        icon: "refresh",
      },
    ];
  }

  getTreeItem(node: ActionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.def.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon(node.def.icon);
    item.tooltip = node.def.tooltip ?? node.def.label;
    item.command = {
      command: node.def.command,
      title: node.def.label,
    };
    item.contextValue = "action";
    return item;
  }

  getChildren(): ActionNode[] {
    return this.actions().map((def) => ({ kind: "action", def }));
  }
}
