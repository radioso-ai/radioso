export interface PublicConversationMessageCreatedEvent {
  type: "message.created";
  conversationId: string;
  workspaceId: string;
  messageId: string;
  createdAt: string;
}

export type PublicConversationEvent = PublicConversationMessageCreatedEvent;

type PublicConversationEventListener = (event: PublicConversationEvent) => void;

export interface PublicConversationEventBus {
  publish(event: PublicConversationEvent): void;
  /**
   * `onEventsMissed` runs when events for the conversation may have gone undelivered, because the
   * bus could not hear the other instances for a while. The subscriber re-reads what it shows.
   */
  subscribe(
    conversationId: string,
    listener: PublicConversationEventListener,
    onEventsMissed?: () => void,
  ): () => void;
}

interface Subscription {
  listener: PublicConversationEventListener;
  onEventsMissed?: () => void;
}

/** One process's subscribers, and the fan-out to them; it hears only what this process publishes. */
export class InMemoryPublicConversationEventBus implements PublicConversationEventBus {
  private readonly subscriptionsByConversationId = new Map<string, Set<Subscription>>();

  publish(event: PublicConversationEvent): void {
    const subscriptions = this.subscriptionsByConversationId.get(event.conversationId);
    if (!subscriptions) {
      return;
    }

    for (const subscription of [...subscriptions]) {
      subscription.listener(event);
    }
  }

  subscribe(
    conversationId: string,
    listener: PublicConversationEventListener,
    onEventsMissed?: () => void,
  ): () => void {
    const subscriptions = this.subscriptionsByConversationId.get(conversationId) ?? new Set<Subscription>();
    const subscription: Subscription = { listener, onEventsMissed };
    subscriptions.add(subscription);
    this.subscriptionsByConversationId.set(conversationId, subscriptions);

    return () => {
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) {
        this.subscriptionsByConversationId.delete(conversationId);
      }
    };
  }

  /** Tells every subscriber that events may have gone undelivered; returns how many subscriptions there are. */
  reportEventsMissed(): number {
    let count = 0;
    for (const subscriptions of [...this.subscriptionsByConversationId.values()]) {
      for (const subscription of [...subscriptions]) {
        count += 1;
        subscription.onEventsMissed?.();
      }
    }
    return count;
  }
}
