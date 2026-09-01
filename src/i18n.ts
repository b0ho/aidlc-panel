import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Panel-scoped i18n.
 *
 * vscode.l10n.t() is bound to the IDE display language at load and cannot be
 * re-pointed at runtime, so it can't back an in-panel language switch. This
 * module is a tiny drop-in replacement: t() looks up the shipped Korean bundle
 * (l10n/bundle.l10n.ko.json) when the effective language is Korean, otherwise
 * returns the English source string. The effective language is a stored user
 * preference ("auto" follows the IDE), so the user can flip the panel language
 * independently of the IDE — changes fire onDidChangeLanguage for a live
 * re-render, no reload required.
 */

export type LangPref = "auto" | "en" | "ko";
type Lang = "en" | "ko";

const PREF_KEY = "aidlcPanel.language";

let koBundle: Record<string, string> = {};
let memento: vscode.Memento | undefined;

const emitter = new vscode.EventEmitter<void>();
/** Fires when the panel language preference changes. */
export const onDidChangeLanguage = emitter.event;

/** Load the Korean bundle and bind persisted state. Call once on activate. */
export function initI18n(context: vscode.ExtensionContext): void {
  memento = context.globalState;
  try {
    const bundlePath = path.join(
      context.extensionPath,
      "l10n",
      "bundle.l10n.ko.json",
    );
    koBundle = JSON.parse(fs.readFileSync(bundlePath, "utf8")) as Record<
      string,
      string
    >;
  } catch {
    koBundle = {};
  }
}

/** The stored preference ("auto" when unset). */
export function languagePref(): LangPref {
  const v = memento?.get<LangPref>(PREF_KEY);
  return v === "en" || v === "ko" ? v : "auto";
}

/** The effective language after resolving "auto" against the IDE language. */
export function currentLang(): Lang {
  const pref = languagePref();
  if (pref === "en" || pref === "ko") {
    return pref;
  }
  return vscode.env.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

/** Persist a new preference and notify listeners. */
export async function setLanguagePref(pref: LangPref): Promise<void> {
  await memento?.update(PREF_KEY, pref === "auto" ? undefined : pref);
  emitter.fire();
}

/**
 * Translate a message. English is the base (the message itself); Korean is
 * looked up in the bundle. Positional {0}, {1}, … placeholders are substituted
 * from args — signature-compatible with vscode.l10n.t().
 */
export function t(
  message: string,
  ...args: (string | number | boolean)[]
): string {
  let out = currentLang() === "ko" ? (koBundle[message] ?? message) : message;
  if (args.length > 0) {
    out = out.replace(/\{(\d+)\}/g, (whole, idx) => {
      const value = args[Number(idx)];
      return value === undefined ? whole : String(value);
    });
  }
  return out;
}
