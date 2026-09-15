import * as vscode from "vscode";
import { t } from "./i18n";

/**
 * A user-defined action row in the Actions view. Clicking it hands `prompt` to
 * Kiro (copied to the clipboard, and submitted where the build allows it), just
 * like the built-in "Continue workflow" row. `newSession` decides whether a
 * fresh Kiro session is opened first or the current one is reused.
 *
 * Stored verbatim in the `aidlcPanel.customActions` setting, so users can also
 * add/edit them from the Settings UI or settings.json — whichever they prefer.
 */
export interface CustomAction {
  id: string;
  label: string;
  prompt: string;
  newSession: boolean;
}

const SECTION = "aidlcPanel";
const KEY = "customActions";

/** A short, collision-resistant id for a newly created action. */
export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Read + normalize the configured custom actions. Tolerant of hand-edited
 *  settings: drops malformed entries and fills in defaults/ids. */
export function getCustomActions(): CustomAction[] {
  const raw = vscode.workspace.getConfiguration(SECTION).get<unknown>(KEY, []);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(
      (x): x is Record<string, unknown> => !!x && typeof x === "object",
    )
    .map((x) => ({
      id: typeof x.id === "string" && x.id ? x.id : genId(),
      label: typeof x.label === "string" ? x.label.trim() : "",
      prompt: typeof x.prompt === "string" ? x.prompt : "",
      // Default to a new session (matches "Continue workflow").
      newSession: x.newSession !== false,
    }))
    .filter((a) => a.label !== "" && a.prompt !== "");
}

/** Persist the full list. Saved at the Global level so custom actions follow
 *  the user across every workspace. */
async function save(actions: CustomAction[]): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update(KEY, actions, vscode.ConfigurationTarget.Global);
}

export async function addAction(action: CustomAction): Promise<void> {
  await save([...getCustomActions(), action]);
}

export async function updateAction(action: CustomAction): Promise<void> {
  await save(
    getCustomActions().map((a) => (a.id === action.id ? action : a)),
  );
}

export async function deleteAction(id: string): Promise<void> {
  await save(getCustomActions().filter((a) => a.id !== id));
}

/**
 * Guided create/edit flow: label → prompt → new-session choice. Returns the
 * assembled action, or undefined if the user cancels at any step. Pass an
 * existing action to pre-fill the fields (edit mode).
 */
export async function promptForAction(
  existing?: CustomAction,
): Promise<CustomAction | undefined> {
  const title = existing ? t("Edit custom action") : t("New custom action");

  const label = await vscode.window.showInputBox({
    title,
    prompt: t("Label shown in the Actions list"),
    value: existing?.label ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : t("Enter a label.")),
  });
  if (label === undefined) {
    return undefined;
  }

  const prompt = await vscode.window.showInputBox({
    title,
    prompt: t("Prompt copied to Kiro when this action is clicked"),
    value: existing?.prompt ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : t("Enter a prompt.")),
  });
  if (prompt === undefined) {
    return undefined;
  }

  const sessionPick = await vscode.window.showQuickPick(
    [
      {
        label: t("New session"),
        detail: t("Open a fresh Kiro session, then paste the prompt"),
        val: true,
      },
      {
        label: t("Current session"),
        detail: t("Reuse the active Kiro session"),
        val: false,
      },
    ],
    {
      title,
      placeHolder: t("Open a new Kiro session when this action runs?"),
    },
  );
  if (!sessionPick) {
    return undefined;
  }

  return {
    id: existing?.id ?? genId(),
    label: label.trim(),
    prompt,
    newSession: sessionPick.val,
  };
}
