import { randomUUID } from "node:crypto";

import type {
  CopilotConversation,
  CopilotMessage,
  CopilotProposal,
  CopilotProposalApplyClaimGuard,
  CopilotProposalClaim,
  CopilotRepositoryPort,
  CopilotRetentionPort,
} from "../../src/modules/operatorCopilot/public.js";

/**
 * In-memory {@link CopilotRepositoryPort} for tests that drive a whole copilot turn: the HTTP test
 * app, the service unit tests, and the Ray eval suite. The collections are public so a test can
 * assert on what a turn persisted without going through the port.
 */
export class InMemoryCopilotRepository implements CopilotRepositoryPort, CopilotRetentionPort {
  conversations: CopilotConversation[] = [];
  messages: CopilotMessage[] = [];
  proposals: CopilotProposal[] = [];
  // Mirrors copilot_proposals.apply_started_at: kept out of the public CopilotProposal shape
  // (only claiming/finalizing needs it), the same narrowing the real repository does by not
  // including the column in `proposalColumns`.
  private readonly applyClaims = new Map<string, Date>();

  /** Mirrors the real sweep, including the cascade the FKs perform on the owning conversation. */
  async deleteConversationsUpdatedBefore(input: { cutoff: Date; limit: number }): Promise<number> {
    const expired = this.conversations
      .filter((conversation) => conversation.updatedAt < input.cutoff)
      .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
      .slice(0, input.limit);
    const ids = new Set(expired.map((conversation) => conversation.id));
    this.conversations = this.conversations.filter((conversation) => !ids.has(conversation.id));
    this.messages = this.messages.filter((message) => !ids.has(message.conversationId));
    this.proposals = this.proposals.filter((proposal) => !ids.has(proposal.conversationId));
    return ids.size;
  }

  async createConversation(input: { workspaceId: string; operatorUserId: string; title: string | null }): Promise<CopilotConversation> {
    const timestamp = new Date();
    const conversation: CopilotConversation = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      operatorUserId: input.operatorUserId,
      title: input.title,
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.conversations.push(conversation);
    return conversation;
  }

  async findConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | null> {
    return (
      this.conversations.find(
        (conversation) =>
          conversation.id === input.id &&
          conversation.workspaceId === input.workspaceId &&
          conversation.operatorUserId === input.operatorUserId,
      ) ?? null
    );
  }

  async listConversations(input: { workspaceId: string; operatorUserId: string }): Promise<ReadonlyArray<CopilotConversation>> {
    return this.conversations
      .filter((conversation) => conversation.workspaceId === input.workspaceId && conversation.operatorUserId === input.operatorUserId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async deleteConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<boolean> {
    const existing = await this.findConversation(input);
    if (!existing) return false;
    this.conversations = this.conversations.filter((conversation) => conversation.id !== existing.id);
    this.messages = this.messages.filter((message) => message.conversationId !== existing.id);
    return true;
  }

  async createMessage(input: Omit<CopilotMessage, "id" | "createdAt">): Promise<CopilotMessage> {
    const message: CopilotMessage = { ...input, id: randomUUID(), createdAt: new Date() };
    this.messages.push(message);
    return message;
  }

  async listMessages(input: { conversationId: string }): Promise<ReadonlyArray<CopilotMessage>> {
    return this.messages.filter((message) => message.conversationId === input.conversationId).map((message) => ({
      ...message,
      proposals: this.proposals.filter((proposal) => proposal.messageId === message.id).map((proposal) => ({
        id: proposal.id,
        targetType: proposal.targetType,
        // Mirrors presentProposalCard's own name-bearing-vs-setting-bearing split (copilotRepository.ts):
        // every target type reads its label from payload.name except agent_setting, which reads
        // targetRef.settingKey.
        targetLabel: proposal.targetType !== "agent_setting" && proposal.payload && typeof proposal.payload === "object" && "name" in proposal.payload && typeof proposal.payload.name === "string" ? proposal.payload.name : proposal.targetType === "agent_setting" && proposal.targetRef && typeof proposal.targetRef === "object" && "settingKey" in proposal.targetRef && typeof proposal.targetRef.settingKey === "string" ? proposal.targetRef.settingKey : "",
        summary: proposal.payload && typeof proposal.payload === "object" && "rationale" in proposal.payload && typeof proposal.payload.rationale === "string" ? proposal.payload.rationale : proposal.targetType !== "agent_setting" && proposal.payload && typeof proposal.payload === "object" && "name" in proposal.payload && typeof proposal.payload.name === "string" ? proposal.payload.name : "",
        status: proposal.status,
        reason: proposal.reason ?? null,
        // Mirrors presentProposalCard's own removal discriminator: only an explicit
        // `op: "remove"` on a directive proposal's payload reads as a removal.
        ...(proposal.targetType === "directive" && proposal.payload && typeof proposal.payload === "object" && "op" in proposal.payload && proposal.payload.op === "remove" ? { removal: true as const } : {}),
      })),
    }));
  }

  async acquireTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | "running" | null> {
    const conversation = await this.findConversation(input);
    if (!conversation) return null;
    if (conversation.status === "running") return "running";
    return this.replaceStatus(conversation, "running");
  }

  async finishTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<void> {
    const conversation = await this.findConversation(input);
    if (conversation) this.replaceStatus(conversation, "idle");
  }

  async createProposal(input: Omit<CopilotProposal, "id" | "messageId" | "status" | "appliedRef" | "createdAt" | "updatedAt">): Promise<CopilotProposal> {
    const createdAt = new Date();
    const proposal: CopilotProposal = { ...input, id: randomUUID(), messageId: null, status: "pending", reason: null, appliedRef: null, createdAt, updatedAt: createdAt };
    this.proposals.push(proposal);
    return proposal;
  }

  async findProposal(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotProposal | null> {
    return this.proposals.find((proposal) => proposal.id === input.id && proposal.workspaceId === input.workspaceId && proposal.operatorUserId === input.operatorUserId) ?? null;
  }

  async attachProposalsToMessage(input: { proposalIds: ReadonlyArray<string>; messageId: string; conversationId: string }): Promise<void> {
    this.proposals = this.proposals.map((proposal) => input.proposalIds.includes(proposal.id) && proposal.conversationId === input.conversationId ? { ...proposal, messageId: input.messageId, updatedAt: new Date() } : proposal);
  }

  async updateProposalOutcome(input: { id: string; workspaceId: string; operatorUserId: string; status: CopilotProposal["status"]; appliedRef?: unknown | null; reason?: string | null; applyClaimGuard: CopilotProposalApplyClaimGuard }): Promise<CopilotProposal | null> {
    const proposal = await this.findProposal(input);
    if (!proposal || proposal.status !== "pending") return null;
    if (!this.satisfiesClaimGuard(proposal.id, input.applyClaimGuard)) return null;
    const updated = { ...proposal, status: input.status, reason: input.reason ?? null, appliedRef: input.appliedRef ?? null, updatedAt: new Date() };
    this.proposals[this.proposals.indexOf(proposal)] = updated;
    this.applyClaims.delete(proposal.id);
    return updated;
  }

  async claimProposalApply(input: { id: string; workspaceId: string; operatorUserId: string; claimTtlSeconds: number }): Promise<CopilotProposalClaim | null> {
    const proposal = await this.findProposal(input);
    if (!proposal || proposal.status !== "pending") return null;
    if (!this.isClaimFree(proposal.id, input.claimTtlSeconds)) return null;
    const claimedAt = new Date();
    this.applyClaims.set(proposal.id, claimedAt);
    return { proposal, claimedAt };
  }

  /** Clears only the exact claim `claimProposalApply` handed to this attempt, mirroring the real repository's fencing. */
  async releaseProposalApplyClaim(input: { id: string; workspaceId: string; operatorUserId: string; claimedAt: Date }): Promise<boolean> {
    const proposal = await this.findProposal(input);
    if (!proposal || proposal.status !== "pending") return false;
    const claimedAt = this.applyClaims.get(proposal.id);
    if (!claimedAt || claimedAt.getTime() !== input.claimedAt.getTime()) return false;
    this.applyClaims.delete(proposal.id);
    return true;
  }

  private isClaimFree(proposalId: string, claimTtlSeconds: number): boolean {
    const claimedAt = this.applyClaims.get(proposalId);
    return !claimedAt || Date.now() - claimedAt.getTime() >= claimTtlSeconds * 1000;
  }

  private satisfiesClaimGuard(proposalId: string, guard: CopilotProposalApplyClaimGuard): boolean {
    if (guard.state === "free") return this.isClaimFree(proposalId, guard.claimTtlSeconds);
    const claimedAt = this.applyClaims.get(proposalId);
    return claimedAt !== undefined && claimedAt.getTime() === guard.claimedAt.getTime();
  }

  private replaceStatus(conversation: CopilotConversation, status: CopilotConversation["status"]): CopilotConversation {
    const next: CopilotConversation = { ...conversation, status, updatedAt: new Date() };
    this.conversations[this.conversations.indexOf(conversation)] = next;
    return next;
  }
}
