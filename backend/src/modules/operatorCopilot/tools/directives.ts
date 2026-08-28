import { z } from "zod";

import type {
  CopilotAuditPort,
  CopilotAgentSettingProposalAdapter,
  CopilotAgentSkillProposalAdapter,
  CopilotContextVariableProposalAdapter,
  CopilotDirectiveProposalAdapter,
  CopilotRoutineProposalAdapter,
  CopilotToolDescriptor,
} from "../contracts.js";
import type { CopilotRepositoryPort } from "../service.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  describeNamedAgent,
  entity,
  recordProposalCreated,
  requiredCopilotConversation,
  requiredPageAgent,
  type CopilotAgentLookupPort,
  citedEvidenceSchema,
  citedProposalEvidence,
  proposalEvidenceOutput,
  proposalOutputSchema,
  type CopilotProposalEvidenceDependencies,
} from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
export interface DirectiveProposalCopilotToolDependencies extends CopilotProposalEvidenceDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter | CopilotAgentSkillProposalAdapter | CopilotContextVariableProposalAdapter>;
  readonly auditService: CopilotAuditPort;
}
const describeDirectiveToolAgent = (
  deps: Pick<DirectiveProposalCopilotToolDependencies, "agentLookup">,
  input: { agentId?: string; agentName?: string },
  context: Parameters<NonNullable<CopilotToolDescriptor["describeEntity"]>>[1],
) => input.agentName
  ? describeNamedAgent(input, context, deps.agentLookup)
  : entity("agent", input.agentId ?? context?.pageContext.agentId);

export const createDirectiveProposalCopilotTools = (
  deps: DirectiveProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const directiveAdapter = proposalAdapter(deps.proposalAdapters);
  return [
    {
      name: "propose_directive", shape: "propose", uiLabel: "Drafting a directive", contributingModule: "directives", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description: "Draft a directive proposal for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema.optional(), intent: z.string().trim().min(1).max(20_000), evidenceIds: citedEvidenceSchema }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_directive",
        description: "Draft a directive proposal for operator review. It does not change configuration.",
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema.optional(), intent: z.string().trim().min(1).max(20_000), evidenceIds: citedEvidenceSchema }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, directiveId, intent, evidenceIds }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), directiveId: directiveId ?? null };
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const draft = await directiveAdapter.draft(context.workspaceId, targetRef, intent);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const versionToken = await directiveAdapter.readVersionToken(context.workspaceId, targetRef);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const evidence = await citedProposalEvidence(deps, context, targetRef.agentId, evidenceIds, { targetType: "directive" });
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "directive",
            targetRef,
            payload: draft.payload,
            versionToken,
            evidence,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "directive" as const, targetLabel: draft.targetLabel, summary: draft.summary, ...proposalEvidenceOutput(evidence) };
        },
      }),
      describeEntity: (input, context) => describeDirectiveToolAgent(deps, input as { agentId?: string; agentName?: string }, context),
    },
    {
      name: "propose_directive_removal", shape: "propose", uiLabel: "Proposing directive removal", contributingModule: "directives", dashboardSubject: { type: "proposal" }, requiredPermissions: ["workspace.agents.manage"],
      description: "Propose permanently removing a directive from an agent, for the operator to review and apply. Drafts nothing; applying the proposal deletes the directive and this cannot be undone.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema, evidenceIds: citedEvidenceSchema }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_directive_removal",
        description: "Propose permanently removing a directive from an agent, for operator review. Applying the proposal deletes the directive and this cannot be undone.",
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema, evidenceIds: citedEvidenceSchema }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, directiveId, evidenceIds }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), directiveId };
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          // Throws when the directive does not exist, or belongs to a different agent, so the tool
          // fails clearly instead of silently proposing to remove nothing.
          const versionToken = await directiveAdapter.readVersionToken(context.workspaceId, targetRef);
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const preview = await directiveAdapter.preview(context.workspaceId, targetRef, { op: "remove" });
          const summary = `Permanently remove the directive "${preview.targetLabel}". This cannot be undone.`;
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const evidence = await citedProposalEvidence(deps, context, targetRef.agentId, evidenceIds, { targetType: "directive", directiveId });
          await requireCurrentCopilotPermissions(context, ["workspace.agents.manage"]);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "directive",
            targetRef,
            payload: { op: "remove" as const, name: preview.targetLabel, rationale: summary },
            versionToken,
            evidence,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "directive" as const, targetLabel: preview.targetLabel, summary, removal: true as const, ...proposalEvidenceOutput(evidence) };
        },
      }),
      describeEntity: (input, context) => describeDirectiveToolAgent(deps, input as { agentId?: string; agentName?: string }, context),
    },
  ];
};
const proposalAdapter = (adapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter | CopilotAgentSkillProposalAdapter | CopilotContextVariableProposalAdapter>): CopilotDirectiveProposalAdapter => {
  const adapter = adapters.find((candidate) => candidate.targetType === "directive");
  if (!adapter) throw new Error("No copilot proposal adapter registered for directive");
  return adapter as CopilotDirectiveProposalAdapter;
};
