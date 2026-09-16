import { z } from "zod";

import type { AgentRetrievalAuthoringPort } from "../../agentSkills/public.js";
import type { CopilotMcpProposalRecoveryPort, CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import { canonicalReviewedOperationDigest } from "../reviewedOperation.js";
import { copilotProposalOrigin, recordProposalCreated, type CopilotProposalToolDependencies } from "./shared.js";

const id = z.string().uuid();
const settingsPatch = z.object({
  sourceScope: z.union([z.literal("all"), z.object({ sourceIds: z.array(id).max(200) }).strict()]).optional(),
  instruction: z.string().max(2_000).optional(),
  retrievalStrategy: z.enum(["fixed", "reasoning", "auto"]).optional(),
  vectorTopK: z.number().int().min(1).max(300).optional(),
  rerankEnabled: z.boolean().optional(),
  rerankTopK: z.number().int().min(1).max(100).optional(),
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
  target: z.object({ agentId: id, skillId: id, skillName: z.string() }).strict(),
  before: z.record(z.unknown()),
  after: z.record(z.unknown()),
  settingsVersion: z.string().datetime(),
  lifecycle: z.literal("agent_skill_draft"),
});

export interface RetrievalAuthoringCopilotToolDependencies extends CopilotProposalToolDependencies {
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
    description: "Read code-owned retrieval defaults and this agent's writable default retrieval skill. System defaults are read-only.", inputSchema: inspectInput, outputSchema: inspectOutput,
    createTool: (context) => ({
      name: "retrieval_settings", description: "Read code-owned retrieval defaults and this agent's writable default retrieval skill. System defaults are read-only.", inputSchema: inspectInput, outputSchema: inspectOutput,
      invoke: async ({ agentId }) => deps.retrievalAuthoring.inspect({ workspaceId: context.workspaceId, agentId }),
    }),
    describeEntity: (input) => ({ type: "agent", id: (input as { agentId: string }).agentId }),
  },
  {
    name: "prepare_retrieval_settings", shape: "propose", verificationCost: () => 0, uiLabel: "Preparing retrieval settings", contributingModule: "agentSkills", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
    description: "Prepare an omission-preserving per-agent retrieval settings patch for review. It does not change retrieval behavior.", inputSchema: prepareInput, outputSchema: prepareOutput,
    reconcileMcpInvocation: async ({ invocation, context, staleBefore, now }) => {
      if (!invocation.operationId) return { status: "conflict" };
      const recovered = await deps.proposalRecovery.recoverOperatorMcpProposal({ invocationId: invocation.id, grantId: invocation.grantId, workspaceId: context.workspaceId, operatorUserId: context.operatorUserId, operationId: invocation.operationId, descriptorName: "prepare_retrieval_settings", inputDigest: invocation.inputDigest, staleBefore, now });
      if (recovered.status !== "recovered" || recovered.proposal.targetType !== "agent_skill" || !recovered.proposal.reviewDigest || !recovered.proposal.expiresAt) return recovered.status === "recovered" ? { status: "conflict" } : recovered;
      const snapshot = z.object({ target: z.object({ agentId: id, skillId: id, skillName: z.string() }).strict(), before: z.record(z.unknown()), after: z.record(z.unknown()), settingsVersion: z.string().datetime(), lifecycle: z.literal("agent_skill_draft") }).safeParse(recovered.proposal.reviewSnapshot);
      if (!snapshot.success) return { status: "conflict" };
      return { status: "recovered", output: { proposalId: recovered.proposal.id, reviewDigest: recovered.proposal.reviewDigest, expiresAt: recovered.proposal.expiresAt.toISOString(), ...snapshot.data } };
    },
    createTool: (context) => ({
      name: "prepare_retrieval_settings", description: "Prepare an omission-preserving per-agent retrieval settings patch for review. It does not change retrieval behavior.", inputSchema: prepareInput, outputSchema: prepareOutput,
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
        const reviewDigest = canonicalReviewedOperationDigest({ targetRef, payload, versionToken: prepared.settingsVersion, reviewSnapshot });
        const now = deps.now?.() ?? new Date();
        const expiresAt = new Date(now.getTime() + (deps.reviewTtlMs ?? 15 * 60_000));
        await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
        const proposal = await deps.proposalRepository.createProposal({
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          origin: copilotProposalOrigin(context),
          targetType: "agent_skill",
          targetRef,
          payload,
          versionToken: prepared.settingsVersion,
          evidence: null,
          reviewDigest,
          reviewSnapshot,
          expiresAt,
        });
        await recordProposalCreated(deps.auditService, context, proposal);
        return {
          proposalId: proposal.id,
          reviewDigest,
          expiresAt: expiresAt.toISOString(),
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
