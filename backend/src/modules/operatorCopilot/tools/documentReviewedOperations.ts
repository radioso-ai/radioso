import { z } from "zod";

import {
  describeDocumentReviewedOperationPlan,
  type DocumentReviewedOperationPreparationPort,
} from "../../documents/contracts/index.js";
import { documentMetadataRecordSchema } from "../../documents/public.js";
import type { CopilotMcpProposalRecoveryPort, CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import { canonicalReviewedOperationDigest } from "../reviewedOperation.js";
import { copilotProposalOrigin, type CopilotProposalToolDependencies } from "./shared.js";

const MAX_DOCUMENTS = 100;
const MAX_DOCUMENT_CONTENT = 20_000;
const title = z.string().trim().min(1).max(300);
const document = z.object({
  externalDocumentId: z.string().trim().min(1).max(240),
  title,
  content: z.string().trim().min(1).max(MAX_DOCUMENT_CONTENT),
  metadata: documentMetadataRecordSchema.optional(),
}).strict();
const MAX_IMPORT_SERIALIZED_BYTES = 2_000_000;
const inputSchema = z.object({
  documents: z.array(document).min(1).max(MAX_DOCUMENTS),
  sourceId: z.string().uuid().optional(),
}).strict().superRefine((input, ctx) => {
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_IMPORT_SERIALIZED_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Document import input exceeds the 2,000,000-byte serialized request budget." });
  }
});
const reviewItem = z.object({ externalDocumentId: z.string(), title, contentHash: z.string(), action: z.enum(["create", "replace", "unchanged"]) }).strict();
const outputSchema = z.object({
  proposalId: z.string().uuid(),
  reviewDigest: z.string(),
  expiresAt: z.string().datetime(),
  review: z.object({ counts: z.object({ create: z.number().int(), replace: z.number().int(), unchanged: z.number().int() }).strict(), documents: z.array(reviewItem).max(40), documentsTruncated: z.boolean() }).strict(),
}).strict();

export interface DocumentReviewedOperationToolDependencies extends CopilotProposalToolDependencies {
  readonly proposalRecovery: CopilotMcpProposalRecoveryPort;
  readonly documents: DocumentReviewedOperationPreparationPort;
  readonly now?: () => Date;
  readonly reviewTtlMs?: number;
}

const NAME = "prepare_document_import";
const DESCRIPTION = "Prepare up to 100 inline documents for reviewed import. externalDocumentId is required: importing the same source and id replaces changed content and leaves an unchanged hash alone. Each body is limited to 20,000 characters; the complete JSON input is limited to 2,000,000 UTF-8 bytes.";

export const createDocumentReviewedOperationTools = (deps: DocumentReviewedOperationToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [{
  name: NAME,
  shape: "propose",
  verificationCost: () => 0,
  uiLabel: "Preparing document import",
  description: DESCRIPTION,
  contributingModule: "documents",
  dashboardSubject: { type: "proposal" },
  requiredPermissions: ["workspace.documents.manage"],
  inputSchema,
  outputSchema,
  reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
    if (!invocation.operationId) return { status: "conflict" };
    const recovered = await deps.proposalRecovery.recoverOperatorMcpProposal({ invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: NAME, inputDigest: invocation.inputDigest, staleBefore, now });
    if (recovered.status !== "recovered" || recovered.proposal.targetType !== "document_operation" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return recovered.status === "recovered" ? { status: "conflict" } : recovered;
    const snapshot = z.object({ review: outputSchema.shape.review }).safeParse(recovered.proposal.reviewSnapshot);
    if (!snapshot.success) return { status: "conflict" };
    return { status: "recovered", output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), ...snapshot.data } };
  },
  createTool: (context) => ({
    name: NAME, description: DESCRIPTION, inputSchema, outputSchema,
    invoke: async (rawInput) => {
      const input = inputSchema.parse(rawInput);
      await requireCurrentCopilotPermissions(context, ["workspace.documents.manage"]);
      const plan = await deps.documents.prepareImport({ workspaceId: context.workspaceId, accountId: context.accountId, sourceId: input.sourceId ?? null, documents: input.documents });
      const { review, fullReview, documentCount } = describeDocumentReviewedOperationPlan(plan);
      const payload = plan;
      const targetRef = { sourceId: input.sourceId ?? null };
      const versionToken = plan.fence;
      const reviewSnapshot = { review, fullReview };
      const reviewDigest = canonicalReviewedOperationDigest({ targetRef, payload, versionToken, reviewSnapshot });
      const now = deps.now?.() ?? new Date();
      const expiresAt = new Date(now.getTime() + (deps.reviewTtlMs ?? 15 * 60_000));
      const proposal = await deps.proposalRepository.createProposal({ workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, origin: copilotProposalOrigin(context), targetType: "document_operation", targetRef, payload, versionToken, evidence: null, reviewDigest, reviewSnapshot, expiresAt });
      await deps.auditService.record({ accountId: context.accountId, workspaceId: context.workspaceId, eventType: "copilot.proposal.created", eventStatus: "success", metadata: { proposalId: proposal.id, targetType: "document_operation", operation: "import", documentCount, operatorUserId: context.operatorUserId, surface: context.surface } });
      return { proposalId: proposal.id, reviewDigest, expiresAt: expiresAt.toISOString(), review };
    },
  }),
}, createRemovalTool(deps), createReprocessTool(deps)];

const removalInputSchema = z.object({
  documentIds: z.array(z.string().uuid()).max(200).optional(),
  externalDocumentIds: z.array(z.string().trim().min(1).max(240)).max(200).optional(),
  sourceId: z.string().uuid().optional(),
}).strict().superRefine((input, ctx) => {
  if ((input.documentIds?.length ?? 0) + (input.externalDocumentIds?.length ?? 0) === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide documentIds and/or externalDocumentIds." });
  if (input.externalDocumentIds?.length && !input.sourceId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sourceId is required when externalDocumentIds are supplied." });
  if (input.sourceId && !input.externalDocumentIds?.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sourceId is only used with externalDocumentIds." });
});
const removalReview = z.object({ documents: z.array(z.object({ id: z.string().uuid(), title, updatedAt: z.string().datetime() }).strict()).max(40), unknownIds: z.array(z.string()).max(200), documentsTruncated: z.boolean() }).strict();
const removalOutputSchema = z.object({ proposalId: z.string().uuid(), reviewDigest: z.string(), expiresAt: z.string().datetime(), review: removalReview }).strict();
const REMOVAL_NAME = "prepare_document_removal";
const REMOVAL_DESCRIPTION = "Prepare an exact, reviewed permanent document removal. Unknown ids are returned in the review and no document is deleted until execute_reviewed_proposal receives the confirmed digest.";

function createRemovalTool(deps: DocumentReviewedOperationToolDependencies): CopilotToolDescriptor {
  return {
    name: REMOVAL_NAME, shape: "propose", verificationCost: () => 0, uiLabel: "Preparing document removal", description: REMOVAL_DESCRIPTION,
    contributingModule: "documents", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.documents.manage"], inputSchema: removalInputSchema, outputSchema: removalOutputSchema,
    reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
      if (!invocation.operationId) return { status: "conflict" };
      const recovered = await deps.proposalRecovery.recoverOperatorMcpProposal({ invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: REMOVAL_NAME, inputDigest: invocation.inputDigest, staleBefore, now });
      if (recovered.status !== "recovered" || recovered.proposal.targetType !== "document_operation" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return recovered.status === "recovered" ? { status: "conflict" } : recovered;
      const snapshot = z.object({ review: removalReview }).safeParse(recovered.proposal.reviewSnapshot);
      return snapshot.success ? { status: "recovered", output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), ...snapshot.data } } : { status: "conflict" };
    },
    createTool: (context) => ({ name: REMOVAL_NAME, description: REMOVAL_DESCRIPTION, inputSchema: removalInputSchema, outputSchema: removalOutputSchema, invoke: async (rawInput) => {
      const input = removalInputSchema.parse(rawInput);
      await requireCurrentCopilotPermissions(context, ["workspace.documents.manage"]);
      const plan = await deps.documents.prepareRemoval({ workspaceId: context.workspaceId, documentIds: input.documentIds ?? [], externalDocumentIds: input.externalDocumentIds ?? [], sourceId: input.sourceId ?? null });
      const { review, fullReview, documentCount } = describeDocumentReviewedOperationPlan(plan);
      const targetRef = { sourceId: input.sourceId ?? null };
      const payload = plan;
      const versionToken = plan.fence;
      const reviewSnapshot = { review, fullReview };
      const reviewDigest = canonicalReviewedOperationDigest({ targetRef, payload, versionToken, reviewSnapshot });
      const now = deps.now?.() ?? new Date(); const expiresAt = new Date(now.getTime() + (deps.reviewTtlMs ?? 15 * 60_000));
      const proposal = await deps.proposalRepository.createProposal({ workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, origin: copilotProposalOrigin(context), targetType: "document_operation", targetRef, payload, versionToken, evidence: null, reviewDigest, reviewSnapshot, expiresAt });
      await deps.auditService.record({ accountId: context.accountId, workspaceId: context.workspaceId, eventType: "copilot.proposal.created", eventStatus: "success", metadata: { proposalId: proposal.id, targetType: "document_operation", operation: "removal", documentCount, operatorUserId: context.operatorUserId, surface: context.surface } });
      return { proposalId: proposal.id, reviewDigest, expiresAt: expiresAt.toISOString(), review };
    } }),
  };
}

const reprocessInputSchema = z.object({ kind: z.enum(["documents", "source", "all"]), documentIds: z.array(z.string().uuid()).min(1).max(200).optional(), sourceId: z.string().uuid().optional(), all: z.boolean().optional() }).strict().superRefine((input, ctx) => {
  const fields = input.kind === "documents" ? [input.documentIds] : input.kind === "source" ? [input.sourceId] : [input.all === true ? true : undefined];
  if (fields[0] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `kind ${input.kind} requires its matching selector.` });
  if (input.kind !== "documents" && input.documentIds !== undefined || input.kind !== "source" && input.sourceId !== undefined || input.kind !== "all" && input.all !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Only the selector matching kind may be supplied." });
});
const reprocessReview = z.object({ kind: z.enum(["documents", "source", "all"]), eligible: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).strict();
const reprocessOutputSchema = z.object({ proposalId: z.string().uuid(), reviewDigest: z.string(), expiresAt: z.string().datetime(), review: reprocessReview }).strict();
const REPROCESS_NAME = "prepare_document_reprocess";
const REPROCESS_DESCRIPTION = "Prepare a reviewed document reprocess. Set kind to documents with documentIds, source with sourceId, or all with all: true. Execution queues eligible documents and reports queued and skipped counts.";

function createReprocessTool(deps: DocumentReviewedOperationToolDependencies): CopilotToolDescriptor {
  return {
    name: REPROCESS_NAME, shape: "propose", verificationCost: () => 0, uiLabel: "Preparing document reprocess", description: REPROCESS_DESCRIPTION,
    contributingModule: "documents", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.documents.manage"], inputSchema: reprocessInputSchema, outputSchema: reprocessOutputSchema,
    reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
      if (!invocation.operationId) return { status: "conflict" };
      const recovered = await deps.proposalRecovery.recoverOperatorMcpProposal({ invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: REPROCESS_NAME, inputDigest: invocation.inputDigest, staleBefore, now });
      if (recovered.status !== "recovered" || recovered.proposal.targetType !== "document_operation" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return recovered.status === "recovered" ? { status: "conflict" } : recovered;
      const snapshot = z.object({ review: reprocessReview }).safeParse(recovered.proposal.reviewSnapshot);
      return snapshot.success ? { status: "recovered", output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), ...snapshot.data } } : { status: "conflict" };
    },
    createTool: (context) => ({ name: REPROCESS_NAME, description: REPROCESS_DESCRIPTION, inputSchema: reprocessInputSchema, outputSchema: reprocessOutputSchema, invoke: async (rawInput) => {
      const input = reprocessInputSchema.parse(rawInput);
      await requireCurrentCopilotPermissions(context, ["workspace.documents.manage"]);
      const selector = { kind: input.kind, ...(input.documentIds ? { documentIds: input.documentIds } : {}), ...(input.sourceId ? { sourceId: input.sourceId } : {}) } as const;
      const plan = await deps.documents.prepareReprocess({ workspaceId: context.workspaceId, ...selector });
      const summary = describeDocumentReviewedOperationPlan(plan);
      const review = { kind: input.kind, ...summary.review };
      const targetRef = { sourceId: input.sourceId ?? null };
      const payload = plan;
      const versionToken = plan.fence; const reviewSnapshot = { review, fullReview: summary.fullReview };
      const reviewDigest = canonicalReviewedOperationDigest({ targetRef, payload, versionToken, reviewSnapshot });
      const now = deps.now?.() ?? new Date(); const expiresAt = new Date(now.getTime() + (deps.reviewTtlMs ?? 15 * 60_000));
      const proposal = await deps.proposalRepository.createProposal({ workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, origin: copilotProposalOrigin(context), targetType: "document_operation", targetRef, payload, versionToken, evidence: null, reviewDigest, reviewSnapshot, expiresAt });
      await deps.auditService.record({ accountId: context.accountId, workspaceId: context.workspaceId, eventType: "copilot.proposal.created", eventStatus: "success", metadata: { proposalId: proposal.id, targetType: "document_operation", operation: "reprocess", kind: input.kind, eligible: summary.review.eligible, operatorUserId: context.operatorUserId, surface: context.surface } });
      return { proposalId: proposal.id, reviewDigest, expiresAt: expiresAt.toISOString(), review };
    } }),
  };
}
