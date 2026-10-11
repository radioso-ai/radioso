import type { ConversationChannelContext } from "@radioso/conversation-contract";

/**
 * A customer message recorded without running a turn. The caller allocates both ids, so a retry
 * with the same ids records nothing twice: a conversation that already exists — even one named
 * by `kind: "new"` — is left as it is, and so is a message that already exists.
 */
export interface ConversationIngestInput {
  workspaceId: string;
  agentId: string | null;
  conversation:
    | { kind: "new"; conversationId: string; sourceChannel: string; channelContext: ConversationChannelContext }
    | { kind: "existing"; conversationId: string };
  message: { id: string; text: string; receivedAt: Date };
  /** Hands the conversation to a person, with this reason, when the AI owns it; null leaves ownership as it is. */
  humanOwnership: { reason: string } | null;
}

export interface ConversationIngestResult {
  conversationId: string;
  messageId: string;
  conversationCreated: boolean;
  messageCreated: boolean;
  /** Ownership as the ingest left it; version 0 while no ownership row exists. */
  ownership: { state: "ai_owned" | "human_owned"; version: number };
}

/** Records a customer's message, and the human ownership asked for, as one unit; runs no turn and reserves no usage. */
export interface ConversationIngestPort {
  ingest(input: ConversationIngestInput): Promise<ConversationIngestResult>;
}
