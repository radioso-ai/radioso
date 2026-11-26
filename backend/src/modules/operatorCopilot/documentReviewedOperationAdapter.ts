import type { CopilotDocumentOperationProposalAdapter } from "./contracts.js";
import {
  documentReviewedOperationPlanSchema,
  documentReviewedOperationTargetRefSchema,
  type DocumentReviewedOperationApplyPort,
} from "../documents/contracts/index.js";

export const createDocumentReviewedOperationAdapter = (deps: {
  readonly operations: DocumentReviewedOperationApplyPort;
}): CopilotDocumentOperationProposalAdapter => ({
  targetType: "document_operation",
  async readVersionToken(workspaceId, rawTargetRef, payload) {
    const plan = documentReviewedOperationPlanSchema.parse(payload);
    const targetRef = documentReviewedOperationTargetRefSchema.parse(rawTargetRef);
    return deps.operations.readReviewedPlanFence({ workspaceId, targetRef, plan });
  },
  /**
   * One row per document, keyed by its title: an import reads as what each document becomes, a
   * removal as documents that go away (no proposed value), a reprocess as documents that are queued again.
   */
  async preview(_workspaceId, _targetRef, payload) {
    const parsed = documentReviewedOperationPlanSchema.parse(payload);
    const keyed = new Map<string, number>();
    const keyFor = (title: string) => {
      const seen = keyed.get(title) ?? 0;
      keyed.set(title, seen + 1);
      return seen === 0 ? title : `${title} (${seen + 1})`;
    };
    if (parsed.operation === "import") {
      return {
        targetLabel: `Import ${parsed.documents.length} ${parsed.documents.length === 1 ? "document" : "documents"}`,
        current: null,
        proposed: Object.fromEntries(parsed.documents.map((document) => [keyFor(document.title), document.action])),
      };
    }
    if (parsed.operation === "removal") {
      return {
        targetLabel: `Remove ${parsed.documents.length} ${parsed.documents.length === 1 ? "document" : "documents"}`,
        current: Object.fromEntries(parsed.documents.map((document) => [keyFor(document.title), "Stored"])),
        proposed: {},
      };
    }
    const rows = parsed.documents.map((document) => ({ key: keyFor(document.title ?? document.id), status: document.status }));
    return {
      targetLabel: `Reprocess ${parsed.documents.length} ${parsed.documents.length === 1 ? "document" : "documents"}`,
      current: Object.fromEntries(rows.map((row) => [row.key, row.status])),
      proposed: Object.fromEntries(rows.map((row) => [row.key, "Queued again"])),
    };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token, context) {
    const targetRef = documentReviewedOperationTargetRefSchema.parse(rawTargetRef);
    const plan = documentReviewedOperationPlanSchema.parse(rawPayload);
    if (!context?.accountId) return { outcome: "failed", reason: "Missing account context" };
    if (token !== plan.fence) return { outcome: "stale" };
    return deps.operations.applyReviewedPlan({ workspaceId, accountId: context.accountId, targetRef, plan });
  },
  async reconcileMcpInterruptedApply(input) {
    const targetRef = documentReviewedOperationTargetRefSchema.parse(input.targetRef);
    const plan = documentReviewedOperationPlanSchema.parse(input.payload);
    if (input.versionToken !== plan.fence) return { outcome: "unknown", reason: "The reviewed document-operation fence is invalid." };
    return deps.operations.reconcileInterruptedApply({ workspaceId: input.workspaceId, targetRef, plan });
  },
});
