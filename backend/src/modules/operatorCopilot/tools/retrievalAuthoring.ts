import { z } from "zod";

import type { AgentRetrievalAuthoringPort } from "../../agentSkills/public.js";
import type { CopilotMcpProposalRecoveryPort, CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import { reviewedConfirmationSchema } from "../reviewedOperation.js";
import { persistReviewedPreparation, reviewedPreparationConfirmation, type ReviewedPreparationDependencies } from "./reviewedPreparation.js";
import type { CopilotProposalToolDependencies } from "./shared.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

// Both tools carry the pool rule so Ray sees it whether it reads settings or prepares a patch.
const answerPoolRule = `vectorTopK sets how deep each search fetches before metadata filters, boosts and merging; only the top max(rerankTopK, ${RETRIEVAL_BEHAVIOR.finalContextTopK}) results, capped at ${RETRIEVAL_BEHAVIOR.rerank.candidateLimit}, go on to the answer, which uses at most ${RETRIEVAL_BEHAVIOR.finalContextTopK} passages, ${RETRIEVAL_BEHAVIOR.promptContextMaxPerDocument} per document. A deeper fetch helps when filters or boosts promote lower-ranked chunks; otherwise raise rerankTopK with it.`;
const retrievalSettingsDescription = `Read code-owned retrieval defaults and this agent's writable default retrieval skill. System defaults are read-only. ${answerPoolRule}`;
const prepareRetrievalSettingsDescription = `Prepare an omission-preserving per-agent retrieval settings patch for review. It does not change retrieval behavior. ${answerPoolRule}`;

const id = z.string().uuid();
const settingsPatch = z.object({
  sourceScope: z.union([z.literal("all"), z.object({ sourceIds: z.array(id).max(200) }).strict()]).optional(),
  instruction: z.string().max(2_000).optional(),
  retrievalStrategy: z.enum(["fixed", "reasoning", "auto"]).optional(),
  vectorTopK: z.number().int().min(1).max(300).optional(),
  rerankEnabled: z.boolean().optional(),
  rerankTopK: z.number().int().min(1).max(RETRIEVAL_BEHAVIOR.rerank.candidateLimit).optional(),
  citationHoldEnabled: z.boolean().optional(),
  queryRewriteEnabled: z.boolean().optional(),
  temporalStructuredLookupEnabled: z.boolean().optional(),
  temporalBoostUpcomingEnabled: z.boolean().optional(),
  temporalDeterministicSortEnabled: z.boolean().optional(),
  semanticRewriteInstructions: z.string().max(2_000).optional(),
  lexicalRewriteInstructions: z.string().max(2_000).optional(),
  suggestedQuestionsEnabled: z.boolean().optional(),
  suggestedQuestionsCount: z.number().int().min(1).max(4).optional(),
  metadataRules: z.array(z.unknown()).max(200).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one retrieval setting must be provided");

const inspectInput = z.object({ agentId: id }).strict();
const inspectOutput = z.object({
  systemDefaults: z.object({ readOnly: z.literal(true), settings: z.unknown() }),
  agent: z.object({ agentId: id, skillId: id, settingsVersion: z.string().datetime(), settings: z.record(z.unknown()), lifecycle: z.literal("agent_skill_draft") }),
});
const prepareInput = z.object({ agentId: id, patch: settingsPatch }).strict();
const prepareOutput = z.object({
  proposalId: id,
  reviewDigest: z.string(),
  expiresAt: z.string().datetime(),
  confirmation: reviewedConfirmationSchema,
  target: z.object({ agentId: id, skillId: id, skillName: z.string() }).strict(),
  before: z.record(z.unknown()),
  after: z.record(z.unknown()),
  settingsVersion: z.string().datetime(),
  lifecycle: z.literal("agent_skill_draft"),
});

export interface RetrievalAuthoringCopilotToolDependencies extends ReviewedPreparationDependencies, CopilotProposalToolDependencies {
  readonly proposalRecovery: CopilotMcpProposalRecoveryPort;
  readonly retrievalAuthoring: AgentRetrievalAuthoringPort;
  readonly now?: () => Date;
  readonly reviewTtlMs?: number;
}

/**
 * Unregistered until the Operator MCP catalog composition supplies its reviewed-execution
 * descriptor. Preparation stores an immutable, digest-bound `agent_skill` proposal because the
 * default retrieve skill's existing adapter owns the CAS-fenced draft mutation.
 */
export const createRetrievalAuthoringCopilotTools = (
  deps: RetrievalAuthoringCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "retrieval_settings", shape: "read", verificationCost: () => 0, uiLabel: "Reading retrieval settings", contributingModule: "agentSkills", dashboardSubject: { type: "agent" }, requiredPermissions: ["workspace.agents.read"],
    description: retrievalSettingsDescription, inputSchema: inspectInput, outputSchema: inspectOutput,
    createTool: (context) => ({
      name: "retrieval_settings", description: retrievalSettingsDescription, inputSchema: inspectInput, outputSchema: inspectOutput,
      invoke: async ({ agentId }) => deps.retrievalAuthoring.inspect({ workspaceId: context.workspaceId, agentId }),
    }),
    describeEntity: (input) => ({ type: "agent", id: (input as { agentId: string }).agentId }),
  },
  {
    name: "prepare_retrieval_settings", shape: "propose", verificationCost: () => 0, uiLabel: "Preparing retrieval settings", contributingModule: "agentSkills", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"], surfaces: ["mcp"],
    description: prepareRetrievalSettingsDescription, inputSchema: prepareInput, outputSchema: prepareOutput,
    reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
      if (!invocation.operationId) return { status: "conflict" };
      const recovered = await deps.proposalRecovery.recoverOperatorMcpProposal({ invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: "prepare_retrieval_settings", inputDigest: invocation.inputDigest, staleBefore, now });
      if (recovered.status !== "recovered" || recovered.proposal.targetType !== "agent_skill" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return recovered.status === "recovered" ? { status: "conflict" } : recovered;
      const snapshot = z.object({ target: z.object({ agentId: id, skillId: id, skillName: z.string() }).strict(), before: z.record(z.unknown()), after: z.record(z.unknown()), settingsVersion: z.string().datetime(), lifecycle: z.literal("agent_skill_draft") }).safeParse(recovered.proposal.reviewSnapshot);
      const confirmation = reviewedPreparationConfirmation(deps, recovered.proposal);
      if (!snapshot.success || !confirmation) return { status: "conflict" };
      return { status: "recovered", output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), confirmation, ...snapshot.data } };
    },
    createTool: (context) => ({
      name: "prepare_retrieval_settings", description: prepareRetrievalSettingsDescription, inputSchema: prepareInput, outputSchema: prepareOutput,
      invoke: async (rawInput) => {
        const input = prepareInput.parse(rawInput);
        await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
        const prepared = await deps.retrievalAuthoring.preparePatch({ workspaceId: context.workspaceId, agentId: input.agentId, patch: input.patch });
        const targetRef = { agentId: prepared.agentId, skillId: prepared.skillId };
        // `agent_skill` is intentional: its existing proposal adapter writes the full reviewed
        // config through AgentSkillsService under this exact settings-version fence.
        const payload = { ...prepared.skill, config: prepared.config };
        const reviewSnapshot = {
          target: { agentId: prepared.agentId, skillId: prepared.skillId, skillName: prepared.skill.name },
          before: prepared.before,
          after: prepared.after,
          settingsVersion: prepared.settingsVersion,
          lifecycle: "agent_skill_draft" as const,
        };
        await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
        const stored = await persistReviewedPreparation({ deps, context, targetType: "agent_skill", targetRef, payload, versionToken: prepared.settingsVersion, reviewSnapshot, operation: "prepare_retrieval_settings", effect: prepared.effect });
        return {
          proposalId: stored.proposal.id,
          reviewDigest: stored.reviewDigest,
          expiresAt: stored.expiresAt.toISOString(),
          confirmation: stored.confirmation,
          target: { agentId: prepared.agentId, skillId: prepared.skillId, skillName: prepared.skill.name },
          before: prepared.before,
          after: prepared.after,
          settingsVersion: prepared.settingsVersion,
          lifecycle: "agent_skill_draft" as const,
        };
      },
    }),
    describeEntity: (input) => ({ type: "agent", id: (input as { agentId: string }).agentId }),
  },
];
