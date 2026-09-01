import * as vscode from "vscode";
import { isQuestionsArtifact, PanelStore } from "./model";

/**
 * Shared review-state store. Persists a per-artifact "reviewed" flag in the
 * workspace Memento, keyed by active intent + artifact name, and notifies every
 * view (artifacts tree, overview, stage detail) when a flag flips. Centralising
 * this keeps the key format in one place so all surfaces agree on counts.
 */
export class ReviewState {
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this._emitter.event;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly store: PanelStore,
  ) {}

  private key(name: string): string {
    const intent = this.store.model?.intent ?? "?";
    return `reviewed:${intent}:${name}`;
  }

  isReviewed(name: string): boolean {
    return this.memento.get<boolean>(this.key(name), false);
  }

  async set(name: string, value: boolean): Promise<void> {
    await this.memento.update(this.key(name), value || undefined);
    this._emitter.fire();
  }

  async toggle(name: string): Promise<void> {
    await this.set(name, !this.isReviewed(name));
  }

  /** Reviewed / total counts across every artifact in the current model. */
  counts(): { reviewed: number; total: number } {
    let reviewed = 0;
    let total = 0;
    for (const stage of this.store.model?.stages ?? []) {
      for (const a of stage.artifacts) {
        // Q&A files are answered, not reviewed — keep them out of review totals.
        if (isQuestionsArtifact(a.name)) {
          continue;
        }
        total += 1;
        if (this.isReviewed(a.name)) {
          reviewed += 1;
        }
      }
    }
    return { reviewed, total };
  }
}
