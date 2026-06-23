import type { ConversationChannelContext } from "@radioso/conversation-contract";

export interface CustomerReplyDeliveryConversation {
  id: string;
  workspaceId: string;
  sourceChannel: string | null;
  channelContext: ConversationChannelContext | null;
}

export interface CustomerReplyDeliveryMessage {
  id?: string;
  content: string;
}

export interface CustomerReplyDeliveryInput {
  conversation: CustomerReplyDeliveryConversation;
  message: CustomerReplyDeliveryMessage;
}

export interface CustomerChannelReplyDeliverer {
  deliver(input: CustomerReplyDeliveryInput): Promise<void>;
}

type CustomerReplyDelivererRegistry = Partial<Record<string, CustomerChannelReplyDeliverer>>;

export class CustomerReplyDeliveryDispatcher implements CustomerChannelReplyDeliverer {
  constructor(private readonly deliverers: CustomerReplyDelivererRegistry = {}) {}

  async deliver(input: CustomerReplyDeliveryInput): Promise<void> {
    const provider = input.conversation.channelContext?.provider
      ?? (input.conversation.sourceChannel === "slack" ? "slack" : null);
    if (!provider || provider === "web") {
      return;
    }
    await this.deliverers[provider]?.deliver(input);
  }
}
