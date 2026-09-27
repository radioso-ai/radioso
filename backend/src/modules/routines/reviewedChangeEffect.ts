import type { ReviewedChangeEffect } from "../../shared/domain/reviewedChangeEffect.js";

export const routineDraftChangeEffect = (kind: "create" | "edit" | "delete"): ReviewedChangeEffect => ({
  exposure: "draft",
  reversibility: kind === "delete" ? "irreversible" : "reversible",
  metered: false,
});
