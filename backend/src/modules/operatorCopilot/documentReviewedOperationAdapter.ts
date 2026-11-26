import type { CopilotDocumentOperationProposalAdapter } from "./contracts.js";
import {
  documentReviewedOperationPlanSchema,
  documentReviewedOperationTargetRefSchema,
  type DocumentReviewedOperationApplyPort,
} from "../documents/contracts/index.js";

/**
 * One unique row label per document id, the title where it is unique. Documents sharing a title,
 * or whose title equals another's label, carry an id suffix, so no two documents collapse into one row.
 */
const rowLabels = (documents: ReadonlyArray<{ readonly id: string; readonly title: string }>): Map<string, string> => {
  const titleCounts = new Map<string, number>();
  for (const document of documents) titleCounts.set(document.title, (titleCounts.get(document.title) ?? 0) + 1);
  const used = new Set<string>();
  const labels = new Map<string, string>();
  for (const document of documents) {
    let label = titleCounts.get(document.title) === 1 && !used.has(document.title) ? document.title : `${document.title} (${document.id.slice(0, 8)})`;
    while (used.has(label)) label = `${label}·`;
    used.add(label);
    labels.set(document.id, label);
  }
  return labels;
};

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
   * One row per document, labelled by its title: an import reads as what each document becomes, a
   * removal as documents that go away (no proposed value), a reprocess as documents that are queued again.
   */
  async preview(_workspaceId, _targetRef, payload) {
    const parsed = documentReviewedOperationPlanSchema.parse(payload);
    const count = `${parsed.documents.length} ${parsed.documents.length === 1 ? "document" : "documents"}`;
    if (parsed.operation === "import") {
      const labels = rowLabels(parsed.documents.map((document) => ({ id: document.externalDocumentId, title: document.title })));
      return {
        targetLabel: `Import ${count}`,
        current: null,
        proposed: Object.fromEntries(parsed.documents.map((document) => [labels.get(document.externalDocumentId)!, document.action])),
      };
    }
    const labels = rowLabels(parsed.documents.map((document) => ({ id: document.id, title: "title" in document && document.title ? document.title : document.id })));
    if (parsed.operation === "removal") {
      return {
        targetLabel: `Remove ${count}`,
        current: Object.fromEntries(parsed.documents.map((document) => [labels.get(document.id)!, "Stored"])),
        proposed: {},
      };
    }
    return {
      targetLabel: `Reprocess ${count}`,
      current: Object.fromEntries(parsed.documents.map((document) => [labels.get(document.id)!, document.status])),
      proposed: Object.fromEntries(parsed.documents.map((document) => [labels.get(document.id)!, "Queued again"])),
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
