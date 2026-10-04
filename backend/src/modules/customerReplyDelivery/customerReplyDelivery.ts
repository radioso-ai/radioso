import type { ConversationChannelContext } from "@radioso/conversation-contract";

export interface CustomerReplyDeliveryConversation {
  id: string;
  workspaceId: string;
  sourceChannel: string | null;
  channelContext: ConversationChannelContext | null;
}

interface CustomerReplyDeliveryMessage {
  id: string;
  content: string;
}

/**
 * The slice of the action outbox a reply's delivery is queued on. The caller passes the one bound
 * to the transaction that writes the reply, so the reply and its delivery commit together.
 */
export interface CustomerReplyOutboxPort {
  enqueue(input: {
    type: string;
    payload: Record<string, unknown>;
    workspaceId?: string | null;
    accountId?: string | null;
    conversationId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ id: string; duplicate: boolean }>;
}

/** Where replies to one conversation go outside the web, resolved before a reply is written. */
export interface CustomerReplyRoute {
  /** Queues the reply's delivery on the caller's outbox, keyed by the message so it goes out once. */
  enqueue(outbox: CustomerReplyOutboxPort, message: CustomerReplyDeliveryMessage): Promise<void>;
}

/**
 * Delivers a teammate's reply to the customer's channel in two steps around the transaction that
 * writes it: {@link route} before the transaction opens — resolving the route can call the
 * channel's provider, which must not hold the transaction's locks — and the route's `enqueue`
 * inside it.
 */
export interface CustomerChannelReplyDeliverer {
  /** Null when replies to the conversation go nowhere outside the web. */
  route(conversation: CustomerReplyDeliveryConversation): Promise<CustomerReplyRoute | null>;
}

type CustomerReplyDelivererRegistry = Partial<Record<string, CustomerChannelReplyDeliverer>>;

export class CustomerReplyDeliveryDispatcher implements CustomerChannelReplyDeliverer {
  constructor(private readonly deliverers: CustomerReplyDelivererRegistry = {}) {}

  async route(conversation: CustomerReplyDeliveryConversation): Promise<CustomerReplyRoute | null> {
    const provider = conversation.channelContext?.provider
      ?? (conversation.sourceChannel === "slack" ? "slack" : null);
    if (!provider || provider === "web") {
      return null;
    }
    return (await this.deliverers[provider]?.route(conversation)) ?? null;
  }
}
