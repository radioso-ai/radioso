import { describe, expect, it } from "vitest";

import { reviewedConfirmationRequirement } from "../../../src/modules/operatorCopilot/reviewedOperation.js";
import type { ReviewedChangeEffect } from "../../../src/shared/domain/reviewedChangeEffect.js";
import { documentReviewedChangeEffect } from "../../../src/modules/documents/contracts/index.js";
import type { DocumentReviewedOperationPlan } from "../../../src/modules/documents/services/documentReviewedOperationPlan.js";
import { routineDraftChangeEffect } from "../../../src/modules/routines/public.js";
import { agentPublicationReviewedEffect } from "../../../src/modules/agents/public.js";
import { ingestionSettingsReviewedEffect } from "../../../src/modules/settings/public.js";

/**
 * Design §4.2's one policy rule: `signed_in_approval` whenever a change goes live, cannot be
 * undone, or spends metered usage; `conversation` only when none of those hold. These tests pin
 * the truth table itself, then §4.3's per-target rows and §4.4's mixed-operation combination,
 * each read from the real owner that declares the effect - never a copilot-side literal.
 */
describe("reviewedConfirmationRequirement (design §4.2 truth table)", () => {
  const draftReversibleUnmetered: ReviewedChangeEffect = { exposure: "draft", reversibility: "reversible", metered: false };

  it("requires only chat confirmation for a draft, reversible, unmetered change", () => {
    expect(reviewedConfirmationRequirement(draftReversibleUnmetered)).toBe("conversation");
  });

  it.each([
    { case: "live exposure alone", effect: { exposure: "live", reversibility: "reversible", metered: false } },
    { case: "irreversibility alone", effect: { exposure: "draft", reversibility: "irreversible", metered: false } },
    { case: "metered alone", effect: { exposure: "draft", reversibility: "reversible", metered: true } },
    { case: "live and irreversible", effect: { exposure: "live", reversibility: "irreversible", metered: false } },
    { case: "live and metered", effect: { exposure: "live", reversibility: "reversible", metered: true } },
    { case: "irreversible and metered", effect: { exposure: "draft", reversibility: "irreversible", metered: true } },
    { case: "live, irreversible, and metered", effect: { exposure: "live", reversibility: "irreversible", metered: true } },
  ] as const)("requires signed-in approval when $case is true", ({ effect }) => {
    expect(reviewedConfirmationRequirement(effect)).toBe("signed_in_approval");
  });
});

describe("design §4.3: per-target tier, read from the real owner", () => {
  it("prepare_routine_structure: create/edit are draft+reversible (conversation); delete is irreversible (signed-in approval)", () => {
    expect(reviewedConfirmationRequirement(routineDraftChangeEffect("create"))).toBe("conversation");
    expect(reviewedConfirmationRequirement(routineDraftChangeEffect("edit"))).toBe("conversation");
    expect(reviewedConfirmationRequirement(routineDraftChangeEffect("delete"))).toBe("signed_in_approval");
  });

  const importPlan = (action: "create" | "replace" | "unchanged"): DocumentReviewedOperationPlan => ({
    operation: "import",
    documents: [{
      externalDocumentId: "doc-1", title: "Doc", content: "text", contentHash: "a".repeat(64),
      expectedDocumentId: null, expectedRevision: null, expectedContentHash: null,
      indexedBytes: 10, storageDeltaBytes: 10, action,
    }],
    fence: "fence-1",
  });

  it("prepare_document_import: always live and metered, so always signed-in approval, whether or not a document is replaced", () => {
    const created = documentReviewedChangeEffect(importPlan("create"));
    const replaced = documentReviewedChangeEffect(importPlan("replace"));
    expect(created).toEqual({ exposure: "live", reversibility: "reversible", metered: true });
    expect(replaced).toEqual({ exposure: "live", reversibility: "irreversible", metered: true });
    // The reversibility bit really does flip on `replace` (a fact only the documents owner knows),
    // but both land on the same requirement here because `metered` alone already forces it.
    expect(reviewedConfirmationRequirement(created)).toBe("signed_in_approval");
    expect(reviewedConfirmationRequirement(replaced)).toBe("signed_in_approval");
  });

  it("prepare_document_removal: always live and irreversible", () => {
    const plan: DocumentReviewedOperationPlan = { operation: "removal", documents: [{ id: "11111111-1111-4111-8111-111111111111", title: "Doc", updatedAt: new Date().toISOString() }], unknownIds: [], fence: "fence-1" };
    const effect = documentReviewedChangeEffect(plan);
    expect(effect).toEqual({ exposure: "live", reversibility: "irreversible", metered: false });
    expect(reviewedConfirmationRequirement(effect)).toBe("signed_in_approval");
  });

  it("prepare_document_reprocess: always live and metered", () => {
    const plan: DocumentReviewedOperationPlan = { operation: "reprocess", documents: [{ id: "11111111-1111-4111-8111-111111111111", updatedAt: new Date().toISOString(), status: "ready" }], fence: "fence-1" };
    const effect = documentReviewedChangeEffect(plan);
    expect(effect).toEqual({ exposure: "live", reversibility: "reversible", metered: true });
    expect(reviewedConfirmationRequirement(effect)).toBe("signed_in_approval");
  });

  it("prepare_agent_publication: always live, so always signed-in approval", () => {
    expect(agentPublicationReviewedEffect).toEqual({ exposure: "live", reversibility: "reversible", metered: false });
    expect(reviewedConfirmationRequirement(agentPublicationReviewedEffect)).toBe("signed_in_approval");
  });

  it("prepare_ingestion_settings: live at the next upload with no publication step, still signed-in approval (design Q2)", () => {
    expect(ingestionSettingsReviewedEffect).toEqual({ exposure: "live", reversibility: "reversible", metered: false });
    expect(reviewedConfirmationRequirement(ingestionSettingsReviewedEffect)).toBe("signed_in_approval");
  });
});
