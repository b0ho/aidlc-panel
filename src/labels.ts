import { t } from "./i18n";
import { StageStatus } from "./model";

/** Localized label for a stage status. Resolved at call time so the active
 *  display language is always honoured. */
export function statusLabel(status: StageStatus): string {
  switch (status) {
    case "completed":
      return t("Completed");
    case "in-progress":
      return t("In progress");
    case "awaiting-approval":
      return t("Awaiting approval");
    case "revising":
      return t("Revising");
    case "pending":
      return t("Pending");
    case "skipped":
      return t("Skipped");
    default:
      return status;
  }
}

/** Phase display labels are proper nouns (Initialization … Operation) — the
 *  same in every language, so they are not localized. */
export const PHASE_LABEL: Record<string, string> = {
  initialization: "Initialization",
  ideation: "Ideation",
  inception: "Inception",
  construction: "Construction",
  operation: "Operation",
};
