import * as vscode from "vscode";
import { currentLang, t } from "./i18n";

/**
 * A free-form scratch notepad shown as its own panel section (a sibling of the
 * Tasks / Features views). The text is persisted in workspaceState so it is
 * per-project and survives IDE reloads. Autosaves as you type (debounced in the
 * webview) and on blur, so nothing is lost when the view is hidden.
 */
export class NotepadViewProvider implements vscode.WebviewViewProvider {
  private static readonly KEY = "aidlcPanel.notepad.content";
  private view: vscode.WebviewView | undefined;
  private titleText: string | undefined;

  constructor(private readonly memento: vscode.Memento) {}

  /** Relabel the view section (used on language change). */
  setTitle(title: string): void {
    this.titleText = title;
    if (this.view) {
      this.view.title = title;
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    if (this.titleText) {
      view.title = this.titleText;
    }
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg: { type?: string; text?: string }) => {
      if (msg?.type === "save" && typeof msg.text === "string") {
        void this.memento.update(NotepadViewProvider.KEY, msg.text);
      }
    });
    view.webview.html = this.html(
      this.memento.get<string>(NotepadViewProvider.KEY, ""),
    );
  }

  private html(content: string): string {
    const esc = (v: unknown): string =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const placeholder = esc(
      t("Jot down notes, TODOs, or snippets. Saved automatically per project."),
    );
    return `<!doctype html><html lang="${currentLang()}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); box-sizing: border-box; padding: 8px; display: flex; }
  textarea {
    flex: 1; width: 100%; min-height: 120px; box-sizing: border-box; resize: none;
    font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #8884); border-radius: 6px; padding: 8px; line-height: 1.5;
  }
  textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
</style></head><body>
  <textarea id="note" placeholder="${placeholder}">${esc(content)}</textarea>
<script>
  const vscodeApi = acquireVsCodeApi();
  const note = document.getElementById('note');
  let timer;
  const save = () => vscodeApi.postMessage({ type: 'save', text: note.value });
  note.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  });
  // Flush immediately when focus leaves so a hidden/collapsed view keeps the
  // latest text even if the debounce hasn't fired yet.
  note.addEventListener('blur', () => { clearTimeout(timer); save(); });
</script></body></html>`;
  }
}
