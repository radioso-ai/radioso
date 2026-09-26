import { z } from "zod";

import { ingestionSettingsChangeEffect, type IngestionSettingsFieldProposalPreparation, type IngestionSettingsProposalPatch, type IngestionSettingsProposalPort } from "../../settings/public.js";
import { copilotIngestionSettingsChangeSchema, copilotIngestionSettingsPayloadSchema } from "../contracts/ingestionSettingsAuthoring.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import { persistReviewedPreparation, recoverReviewedPreparation, type ReviewedPreparationDependencies } from "./reviewedPreparation.js";

const NAME = "prepare_ingestion_settings";
const inputSchema = copilotIngestionSettingsChangeSchema;
const outputSchema = z.object({
  proposalId: z.string().uuid(), reviewDigest: z.string().min(1).max(200), expiresAt: z.string().datetime(),
  review: z.object({
    changes: z.array(z.object({ field: z.string().max(200), before: z.unknown(), after: z.unknown() }).strict()).max(25),
    after: z.record(z.unknown()), effect: z.object({ appliesTo: z.literal("documents_processed_after_execution"), existingDocuments: z.literal("unchanged_until_reprocessed"), embeddingModel: z.literal("unchanged") }).strict(),
  }).strict(),
}).strict();

export interface IngestionSettingsReviewedPreparationDependencies extends ReviewedPreparationDependencies {
  readonly ingestionSettings: Pick<IngestionSettingsProposalPort, "prepareFieldProposal" | "readFieldProposalVersion">;
}

export const createIngestionSettingsReviewedPreparationTool = (deps: IngestionSettingsReviewedPreparationDependencies): CopilotToolDescriptor<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> => ({
  name: NAME, shape: "propose", verificationCost: () => 0, uiLabel: "Preparing ingestion settings", contributingModule: "settings",
  description: "Prepare an ingestion settings change for digest-bound review. It affects documents processed after execution; use prepare_document_reprocess for already indexed documents.",
  inputSchema, outputSchema, requiredPermissions: ["workspace.settings.manage"], dashboardSubject: { type: "ingestion_settings" }, surfaces: ["mcp"],
  reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
    const recovered = await recoverReviewedPreparation({ deps, invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: NAME, inputDigest: invocation.inputDigest, staleBefore, now });
    if (recovered.status !== "recovered") return recovered;
    if (recovered.proposal.targetType !== "ingestion_settings" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return { status: "conflict" as const };
    const review = outputSchema.shape.review.safeParse(recovered.proposal.reviewSnapshot);
    return review.success ? { status: "recovered" as const, output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), review: review.data } } : { status: "conflict" as const };
  },
  createTool: (context) => ({ name: NAME, description: "Prepare an ingestion settings change for digest-bound review. It affects documents processed after execution; use prepare_document_reprocess for already indexed documents.", inputSchema, outputSchema, invoke: async (raw) => {
    const change = inputSchema.parse(raw); await requireCurrentCopilotPermissions(context, ["workspace.settings.manage"]);
    const { rationale, ...rawPatch } = change;
    const patch: IngestionSettingsProposalPatch = rawPatch;
    const prepared: IngestionSettingsFieldProposalPreparation = await deps.ingestionSettings.prepareFieldProposal(context.workspaceId, patch);
    const review = { changes: (Object.keys(prepared.expected) as Array<keyof typeof prepared.expected>).map((field) => ({ field, before: prepared.expected[field], after: prepared.normalizedPatch[field] })), after: prepared.display.proposed, effect: ingestionSettingsChangeEffect };
    const payload = copilotIngestionSettingsPayloadSchema.parse({ name: "Ingestion settings", ...prepared.normalizedPatch, ...(rationale === undefined ? {} : { rationale }) });
    const versionToken = await deps.ingestionSettings.readFieldProposalVersion(context.workspaceId, prepared.expected);
    await requireCurrentCopilotPermissions(context, ["workspace.settings.manage"]);
    const stored = await persistReviewedPreparation({ deps, context, targetType: "ingestion_settings", targetRef: { expectedFields: prepared.expected }, payload, versionToken, reviewSnapshot: review, operation: NAME });
    return { proposalId: stored.proposal.id, reviewDigest: stored.reviewDigest, expiresAt: stored.expiresAt.toISOString(), review };
  } }),
});
