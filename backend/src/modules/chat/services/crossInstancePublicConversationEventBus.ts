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
 * sent; `listening` says when that may have happened.
 */
export interface PublicConversationEventRelay {
  send(relayed: RelayedPublicConversationEvent): Promise<void>;
  subscribe(handlers: {
    event(relayed: RelayedPublicConversationEvent): void;
    /**
     * Events are heard from now on. `mayHaveMissed` is true when some sent since subscribing, or
     * since the last `interrupted`, went unheard: the subscription came before the process's
     * LISTEN took effect, or the connection dropped. It is false when the subscription joined a
     * session that already listened, which has heard everything since.
     */
    listening(state: { mayHaveMissed: boolean }): void;
    /** Events sent from now until the next `listening` are not heard. */
    interrupted(): void;
  }): () => void;
}

interface CrossInstancePublicConversationEventBusDependencies {
  /** Unique per process, so the bus can drop its own events when the relay hands them back. */
  instanceId: string;
  relay: PublicConversationEventRelay;
  logger?: Pick<AppLogger, "info" | "warn">;
  /** Returns a number in [0, 1); injected so a test can pin when each subscriber is told. */
  random?: () => number;
}

/**
 * After a gap every subscriber re-reads, and each visitor's re-read is a database query. They are
 * spread over a window that grows by this much per subscriber, about 500 re-reads a second, up to
 * `MISSED_REPORT_MAX_SPREAD_MS`, so a reconnect does not land them on a just-recovered database
 * at once.
 */
const MISSED_REPORT_SPACING_MS = 2;
const MISSED_REPORT_MAX_SPREAD_MS = 5_000;

interface MissedEventsHandler {
  report(): void;
}

/**
 * The public conversation event bus for a deployment of several processes. An event reaches this
 * process's subscribers synchronously as it is published, and every other process's subscribers
 * through the relay, which this process subscribes to while it has subscribers of its own.
 *
 * Subscribers are told that events may have been missed only after a real gap: they subscribed
 * before the process's LISTEN took effect, or the connection dropped and came back. Joining a
 * process that already listens tells nobody anything, so a caller that subscribes, reads, and
 * subscribes again stays parked until an event arrives.
 */
export class CrossInstancePublicConversationEventBus implements PublicConversationEventBus {
  private readonly local = new InMemoryPublicConversationEventBus();
  private readonly missedHandlers = new Set<MissedEventsHandler>();
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
    const unsubscribeLocal = this.local.subscribe(conversationId, listener);
    const missedHandler: MissedEventsHandler | null = onEventsMissed ? { report: onEventsMissed } : null;
    if (missedHandler) {
      this.missedHandlers.add(missedHandler);
    }
    this.subscriberCount += 1;
    this.stopRelay ??= this.dependencies.relay.subscribe({
      event: (relayed) => this.deliverRelayed(relayed),
      listening: (state) => this.relayListening(state),
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
      if (missedHandler) {
        this.missedHandlers.delete(missedHandler);
      }
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

  private relayListening({ mayHaveMissed }: { mayHaveMissed: boolean }): void {
    const resumed = this.relayInterrupted;
    this.relayInterrupted = false;
    if (!mayHaveMissed) {
      return;
    }
    const { subscribers, spreadMs } = this.reportEventsMissed();
    if (resumed) {
      this.dependencies.logger?.info(
        { event: "public_conversation_events_resumed", subscribers, spreadMs },
        "Public conversation events heard again; subscribers re-read their conversations",
      );
    }
  }

  /** Tells each subscriber at a random moment within the spread; one gone by then is skipped. */
  private reportEventsMissed(): { subscribers: number; spreadMs: number } {
    const handlers = [...this.missedHandlers];
    const spreadMs = Math.min(MISSED_REPORT_MAX_SPREAD_MS, handlers.length * MISSED_REPORT_SPACING_MS);
    const random = this.dependencies.random ?? Math.random;
    for (const handler of handlers) {
      const timer = setTimeout(() => {
        if (this.missedHandlers.has(handler)) {
          handler.report();
        }
      }, Math.floor(random() * spreadMs));
      timer.unref();
    }
    return { subscribers: handlers.length, spreadMs };
  }
}
