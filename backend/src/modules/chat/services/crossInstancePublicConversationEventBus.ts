import type { AppLogger } from "../../../shared/observability/logger.js";
import {
  InMemoryPublicConversationEventBus,
  type PublicConversationEvent,
  type PublicConversationEventBus,
} from "./publicConversationEventBus.js";

/** An event on its way between processes, with the process that published it. */
export interface RelayedPublicConversationEvent {
  origin: string;
  event: PublicConversationEvent;
}

/**
 * Carries events between the processes of a deployment. Every listening process hears every event
 * sent, its own included. Nothing is kept for a process that was not listening when an event was
 * sent, so a subscriber learns of that gap through `listening` after an `interrupted`.
 */
export interface PublicConversationEventRelay {
  send(relayed: RelayedPublicConversationEvent): Promise<void>;
  subscribe(handlers: {
    event(relayed: RelayedPublicConversationEvent): void;
    /** Events are heard from now on: on subscribing, and again after every reconnect. */
    listening(): void;
    /** Events sent from now until the next `listening` are not heard. */
    interrupted(): void;
  }): () => void;
}

interface CrossInstancePublicConversationEventBusDependencies {
  /** Unique per process, so the bus can drop its own events when the relay hands them back. */
  instanceId: string;
  relay: PublicConversationEventRelay;
  logger?: Pick<AppLogger, "info" | "warn">;
}

/**
 * The public conversation event bus for a deployment of several processes. An event reaches this
 * process's subscribers synchronously as it is published, and every other process's subscribers
 * through the relay. The process hears the relay only while something in it subscribes.
 *
 * Whenever the relay starts listening (the first subscriber, or a reconnect), every subscriber is
 * told that events may have been missed: an event sent before then reached nobody here, and the
 * subscriber re-reads instead.
 */
export class CrossInstancePublicConversationEventBus implements PublicConversationEventBus {
  private readonly local = new InMemoryPublicConversationEventBus();
  private subscriberCount = 0;
  private stopRelay: (() => void) | null = null;
  private relayInterrupted = false;

  constructor(private readonly dependencies: CrossInstancePublicConversationEventBusDependencies) {}

  publish(event: PublicConversationEvent): void {
    this.local.publish(event);
    void this.dependencies.relay.send({ origin: this.dependencies.instanceId, event }).catch((error: unknown) => {
      this.dependencies.logger?.warn(
        { event: "public_conversation_event_relay_failed", conversationId: event.conversationId, err: error },
        "Public conversation event did not reach the other instances",
      );
    });
  }

  subscribe(
    conversationId: string,
    listener: (event: PublicConversationEvent) => void,
    onEventsMissed?: () => void,
  ): () => void {
    const unsubscribeLocal = this.local.subscribe(conversationId, listener, onEventsMissed);
    this.subscriberCount += 1;
    this.stopRelay ??= this.dependencies.relay.subscribe({
      event: (relayed) => this.deliverRelayed(relayed),
      listening: () => this.relayListening(),
      interrupted: () => {
        this.relayInterrupted = true;
      },
    });

    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      unsubscribeLocal();
      this.subscriberCount -= 1;
      if (this.subscriberCount === 0 && this.stopRelay) {
        const stopRelay = this.stopRelay;
        this.stopRelay = null;
        this.relayInterrupted = false;
        stopRelay();
      }
    };
  }

  private deliverRelayed(relayed: RelayedPublicConversationEvent): void {
    if (relayed.origin === this.dependencies.instanceId) {
      return;
    }
    this.local.publish(relayed.event);
  }

  private relayListening(): void {
    const subscribers = this.local.reportEventsMissed();
    if (this.relayInterrupted) {
      this.relayInterrupted = false;
      this.dependencies.logger?.info(
        { event: "public_conversation_events_resumed", subscribers },
        "Public conversation events heard again; subscribers re-read their conversations",
      );
    }
  }
}
