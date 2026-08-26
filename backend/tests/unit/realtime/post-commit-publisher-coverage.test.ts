import { describe, expect, it } from "vitest";

import { INVALIDATION_KINDS, type WorkspaceInvalidationKind } from "@radioso/workspace-invalidation-contract";

/**
 * Coverage inventory for application-owned post-commit publishers.
 *
 * This is intentionally an audit skeleton, not a substitute for the transaction
 * tests in the owning module.  Every row below must also have a test that proves
 * commit ordering, rollback silence, and conditional no-op silence at its real
 * persistence seam.
 */
const coverage = {
  "document.status_changed": "document transition services / worker",
  "crawl.status_changed": "crawler job and worker lifecycle",
  "crawl.progress": "persisted crawler checkpoint",
  "conversation.created": "conversation creation and external-link upsert",
  "conversation.turn_committed": "assistant-turn transaction persistence and operator reply",
  "conversation.contact_delivery_changed": "action dispatcher persisted outcome",
  "conversation.ownership_changed": "ownership transition application services",
  "search.created": "document search audit commit",
  "hitl.decision_created": "assistant-turn transaction pending-decision persisted insert",
  "hitl.decision_resolved": "outer approval transaction commit",
  "quality.feedback_changed": "answer feedback upsert/clear",
  "quality.triage_changed": "quality triage updated transition result",
} satisfies Record<WorkspaceInvalidationKind, string>;

describe("post-commit publisher coverage inventory", () => {
  it("covers every contract kind exactly once", () => {
    const auditedKinds = Object.keys(coverage).sort();
    expect(auditedKinds).toEqual([...INVALIDATION_KINDS].sort());
    expect(new Set(auditedKinds).size).toBe(INVALIDATION_KINDS.length);
  });

  it("keeps the transaction-boundary proof obligation explicit", () => {
    for (const owner of Object.values(coverage)) {
      expect(owner).toMatch(/commit|transaction|persisted|upsert|transition|lifecycle|dispatcher|audit/i);
    }
  });
});
