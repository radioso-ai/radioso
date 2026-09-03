import type { OpsEventEnvelope } from "./opsEventEnvelope.js";

export interface OpsEventTransport {
  send(envelope: OpsEventEnvelope): Promise<void>;
}

export interface OpsEventDispatcherLogger {
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface OpsEventDispatcherOptions {
  transport: OpsEventTransport;
  logger: OpsEventDispatcherLogger;
  queueLimit?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  autoDrain?: boolean;
}

const DEFAULT_QUEUE_LIMIT = 500;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms).unref?.();
});

/**
 * Hands events to a transport without ever making a caller wait for it.
 *
 * Product analytics and error reporting both await their sinks, so a sink that awaited an
 * HTTP round trip would put an operator's webhook on the critical path of every chat turn.
 * Enqueueing is synchronous and the drain runs detached.
 *
 * The queue is in memory and bounded: a burst past the limit drops the oldest events, and
 * a process restart drops whatever is still queued. The durable copy of every event is the
 * audit sink, so this feed is allowed to be lossy in exchange for never adding latency.
 */
export class OpsEventDispatcher {
  private readonly queue: OpsEventEnvelope[] = [];
  private draining: Promise<void> | null = null;

  constructor(private readonly options: OpsEventDispatcherOptions) {}

  enqueue(envelope: OpsEventEnvelope): void {
    const queueLimit = this.options.queueLimit ?? DEFAULT_QUEUE_LIMIT;

    while (this.queue.length >= queueLimit) {
      const dropped = this.queue.shift();
      this.options.logger.warn(
        { event: "ops_event_dropped", droppedEventName: dropped?.name, queueLimit },
        "Ops event queue is full; dropped the oldest event",
      );
    }

    this.queue.push(envelope);

    if (this.options.autoDrain !== false) {
      this.startDrain();
    }
  }

  async flush(): Promise<void> {
    this.startDrain();
    while (this.draining) {
      await this.draining;
    }
  }

  private startDrain(): void {
    if (this.draining || this.queue.length === 0) {
      return;
    }

    this.draining = this.drain().finally(() => {
      this.draining = null;
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const envelope = this.queue.shift();
      if (!envelope) {
        return;
      }
      await this.deliver(envelope);
    }
  }

  private async deliver(envelope: OpsEventEnvelope): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const retryDelayMs = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const sleep = this.options.sleep ?? defaultSleep;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.options.transport.send(envelope);
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          this.options.logger.error(
            {
              event: "ops_event_delivery_failed",
              eventName: envelope.name,
              attempts: attempt,
              err: error instanceof Error ? error.message : String(error),
            },
            "Ops event delivery failed after every attempt",
          );
          return;
        }
        await sleep(retryDelayMs * attempt);
      }
    }
  }
}
