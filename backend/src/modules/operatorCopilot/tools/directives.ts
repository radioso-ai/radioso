import { z } from "zod";

import type {
  CopilotAuditPort,
  CopilotAgentSettingProposalAdapter,
  CopilotDirectiveProposalAdapter,
  CopilotRoutineProposalAdapter,
  CopilotToolDescriptor,
} from "../contracts.js";
import type { CopilotRepositoryPort } from "../service.js";
import {
  describeNamedAgent,
  entity,
  recordProposalCreated,
  requiredCopilotConversation,
  requiredPageAgent,
  type CopilotAgentLookupPort,
} from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
const proposalOutputSchema = z.object({
  proposalId: z.string().uuid(),
  targetType: z.enum(["directive", "agent_setting", "routine"]),
  targetLabel: z.string(),
  summary: z.string(),
});
export interface DirectiveProposalCopilotToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter>;
  readonly auditService: CopilotAuditPort;
}
export const createDirectiveProposalCopilotTools = (
  deps: DirectiveProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const directiveAdapter = proposalAdapter(deps.proposalAdapters);
  return [
    {
      name: "propose_directive", shape: "propose", uiLabel: "Drafting a directive", contributingModule: "directives", dashboardSubject: { type: "proposal" }, requiredPermission: "workspace.agents.manage",
      description: "Draft a directive proposal for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema.optional(), intent: z.string().trim().min(1).max(20_000) }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_directive",
        description: "Draft a directive proposal for operator review. It does not change configuration.",
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema.optional(), intent: z.string().trim().min(1).max(20_000) }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, directiveId, intent }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), directiveId: directiveId ?? null };
          const draft = await directiveAdapter.draft(context.workspaceId, targetRef, intent);
          const versionToken = await directiveAdapter.readVersionToken(context.workspaceId, targetRef);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "directive",
            targetRef,
            payload: draft.payload,
            versionToken,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "directive" as const, targetLabel: draft.targetLabel, summary: draft.summary };
        },
      }),
      describeEntity: (input, context) => {
        const parsed = input as { agentId?: string; agentName?: string };
        return parsed.agentName
          ? describeNamedAgent(parsed, context, deps.agentLookup)
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
      },
    },

  ];
};
const proposalAdapter = (adapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter>): CopilotDirectiveProposalAdapter => {
  const adapter = adapters.find((candidate) => candidate.targetType === "directive");
  if (!adapter) throw new Error("No copilot proposal adapter registered for directive");
  return adapter as CopilotDirectiveProposalAdapter;
};
