import { z } from "zod";

import { agentReviewedSettingsPatchSchema } from "../../agents/public.js";
import type { CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import { persistReviewedPreparation, recoverReviewedPreparation, type ReviewedPreparationDependencies } from "./reviewedPreparation.js";

const NAME = "prepare_agent_settings";
const inputSchema = z.object({ agentId: z.string().uuid(), patch: agentReviewedSettingsPatchSchema, rationale: z.string().min(1).max(1_000).optional() }).strict();
const outputSchema = z.object({
  proposalId: z.string().uuid(), reviewDigest: z.string().min(1).max(200), expiresAt: z.string().datetime(),
  review: z.object({
    target: z.object({ agentId: z.string().uuid(), agentName: z.string().max(200) }).strict(),
    changes: z.array(z.object({ key: z.string().max(200), before: z.unknown(), after: z.unknown(), lifecycle: z.enum(["live", "agent_draft"]), reach: z.boolean() }).strict()).max(25),
    unchanged: z.array(z.string().max(200)).max(25),
    effects: z.object({ liveKeys: z.array(z.string().max(200)).max(25), draftKeys: z.array(z.string().max(200)).max(25), publicationRequired: z.boolean(), reach: z.boolean() }).strict(),
  }).strict(),
}).strict();

export interface AgentSettingsReviewedPreparationDependencies extends ReviewedPreparationDependencies {
  readonly agentSettings: {
    prepareFieldsProposal(workspaceId: string, agentId: string, patch: Record<string, unknown>): Promise<{ targetAgentId: string; agentName: string; normalizedPatch: Record<string, unknown>; expectedFields: ReadonlyArray<{ key: string; value: unknown }>; changes: ReadonlyArray<{ key: string; current: unknown; proposed: unknown; lifecycle: "live" | "agent_draft"; reach: boolean }>; unchanged: readonly string[] }>;
    readFieldProposalVersion(workspaceId: string, agentId: string, expected: { keys: readonly string[] }): Promise<string>;
  };
}

export const createAgentSettingsReviewedPreparationTool = (deps: AgentSettingsReviewedPreparationDependencies): CopilotToolDescriptor<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> => ({
  name: NAME, shape: "propose", verificationCost: () => 0, uiLabel: "Preparing agent settings", contributingModule: "agents",
  description: "Prepare several settings for one agent as one digest-bound operation. customInstruction is an agent draft and needs prepare_agent_publication before customers see it; other settings are live at execution.",
  inputSchema, outputSchema, requiredPermissions: ["workspace.agents.manage"], dashboardSubject: { type: "agent" }, surfaces: ["mcp"],
  describeEntity: (input) => ({ type: "agent", id: input.agentId }),
  reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
    const recovered = await recoverReviewedPreparation({ deps, invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: NAME, inputDigest: invocation.inputDigest, staleBefore, now });
    if (recovered.status !== "recovered") return recovered;
    if (recovered.proposal.targetType !== "agent_setting" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return { status: "conflict" as const };
    const review = outputSchema.shape.review.safeParse(recovered.proposal.reviewSnapshot);
    return review.success ? { status: "recovered" as const, output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), review: review.data } } : { status: "conflict" as const };
  },
  createTool: (context) => ({ name: NAME, description: "Prepare several settings for one agent as one digest-bound operation. customInstruction is an agent draft and needs prepare_agent_publication before customers see it; other settings are live at execution.", inputSchema, outputSchema, invoke: async (raw) => {
    const input = inputSchema.parse(raw); await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
    const prepared = await deps.agentSettings.prepareFieldsProposal(context.workspaceId, input.agentId, input.patch);
    const liveKeys = prepared.changes.filter((change) => change.lifecycle === "live").map((change) => change.key);
    const draftKeys = prepared.changes.filter((change) => change.lifecycle === "agent_draft").map((change) => change.key);
    const review = { target: { agentId: prepared.targetAgentId, agentName: prepared.agentName }, changes: prepared.changes.map((change) => ({ key: change.key, before: change.current, after: change.proposed, lifecycle: change.lifecycle, reach: change.reach })), unchanged: [...prepared.unchanged], effects: { liveKeys, draftKeys, publicationRequired: draftKeys.length > 0, reach: prepared.changes.some((change) => change.reach) } };
    const payload = { kind: "fields" as const, patch: prepared.normalizedPatch, ...(input.rationale === undefined ? {} : { rationale: input.rationale }) };
    const versionToken = await deps.agentSettings.readFieldProposalVersion(context.workspaceId, input.agentId, { keys: prepared.expectedFields.map((field) => field.key) });
    await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
    const stored = await persistReviewedPreparation({ deps, context, targetType: "agent_setting", targetRef: { agentId: input.agentId, expectedFields: prepared.expectedFields }, payload, versionToken, reviewSnapshot: review, operation: NAME });
    return { proposalId: stored.proposal.id, reviewDigest: stored.reviewDigest, expiresAt: stored.expiresAt.toISOString(), review };
  } }),
});
