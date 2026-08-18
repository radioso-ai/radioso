import type { CopilotAuditPort, CopilotEntityDescription, CopilotProposal } from "../contracts.js";

export interface CopilotAgentListItem {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly assistantBootstrapActive: boolean;
}

export interface CopilotAgentLookupPort {
  listExisting(workspaceId: string): Promise<ReadonlyArray<CopilotAgentListItem>>;
}

export const entity = (type: string, id: string | null | undefined) => id ? { type, id } : null;

type NamedAgentInput = { readonly agentId?: string; readonly agentName?: string };

export const describeNamedAgent = async <TInput extends NamedAgentInput>(
  input: TInput,
  context: { workspaceId: string; pageContext: { agentId: string | null } } | undefined,
  agentLookup: CopilotAgentLookupPort | undefined,
): Promise<CopilotEntityDescription<TInput> | null> => {
  if (input.agentId) return entity("agent", input.agentId);
  if (!input.agentName) return entity("agent", context?.pageContext.agentId);
  if (!context || !agentLookup) return { kind: "not_found" };
  const candidates = (await agentLookup.listExisting(context.workspaceId))
    .filter((agent) => normalizeEntityName(agent.name) === normalizeEntityName(input.agentName!))
    .map((agent) => ({ type: "agent", id: agent.id, label: agent.name }));
  if (candidates.length !== 1) {
    return candidates.length === 0 ? { kind: "not_found" } : { kind: "ambiguous", candidates };
  }
  const candidate = candidates[0]!;
  return {
    kind: "resolved",
    entity: candidate,
    input: { ...input, agentId: candidate.id, agentName: undefined } as TInput,
  };
};

export const normalizeEntityName = (value: string): string => value.trim().normalize("NFKC").toLowerCase();
export const asRecord = (value: object): Record<string, unknown> => value as Record<string, unknown>;
export const requiredPageAgent = (agentId: string | null): string => {
  if (!agentId) throw new Error("No agent context is available");
  return agentId;
};
export const requiredPageConversation = (conversationId: string | null): string => {
  if (!conversationId) throw new Error("No conversation context is available");
  return conversationId;
};
export const requiredCopilotConversation = (context: { copilotConversationId?: string }): string => {
  const conversationId = context.copilotConversationId;
  if (!conversationId) throw new Error("Copilot proposal drafting requires a persisted conversation");
  return conversationId;
};
export const recordProposalCreated = async (
  auditService: CopilotAuditPort,
  context: { accountId: string; workspaceId: string },
  proposal: CopilotProposal,
): Promise<void> => {
  await auditService.record({ accountId: context.accountId, workspaceId: context.workspaceId, eventType: "copilot.proposal.created", eventStatus: "success", metadata: { proposalId: proposal.id, targetType: proposal.targetType } });
};
