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
  async preview(_workspaceId, _targetRef, payload) {
    const parsed = documentReviewedOperationPlanSchema.parse(payload);
    return {
      targetLabel: parsed.operation === "import" ? "Document import" : parsed.operation === "removal" ? "Document removal" : "Document reprocess",
      current: null,
      proposed: { count: parsed.documents.length },
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
