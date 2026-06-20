export interface PublicConversationMessageCreatedEvent {
  type: "message.created";
  conversationId: string;
  workspaceId: string;
  messageId: string;
  createdAt: string;
}

export type PublicConversationEvent = PublicConversationMessageCreatedEvent;

export interface PublicConversationEventBus {
  publish(event: PublicConversationEvent): void;
  subscribe(conversationId: string, listener: (event: PublicConversationEvent) => void): () => void;
}

export class InMemoryPublicConversationEventBus implements PublicConversationEventBus {
  private readonly listenersByConversationId = new Map<string, Set<(event: PublicConversationEvent) => void>>();

  publish(event: PublicConversationEvent): void {
    const listeners = this.listenersByConversationId.get(event.conversationId);
    if (!listeners) {
      return;
    }

    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  subscribe(conversationId: string, listener: (event: PublicConversationEvent) => void): () => void {
    const listeners = this.listenersByConversationId.get(conversationId) ?? new Set<(event: PublicConversationEvent) => void>();
    listeners.add(listener);
    this.listenersByConversationId.set(conversationId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listenersByConversationId.delete(conversationId);
      }
    };
  }
}
