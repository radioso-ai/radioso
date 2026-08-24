import { sql } from "kysely";
import type { Client } from "pg";

import type { WorkspaceEventBus, WorkspaceEventPublish, WorkspaceEventSubscription, PushEvent } from "../events/workspaceEventBus.js";
import { pushEventSchema } from "../events/workspaceEventBus.js";
import type { AppLogger } from "../observability/logger.js";
import type { TelemetryService } from "../observability/telemetry/telemetryService.js";
import type { Database } from "./database.js";

const CHANNEL = "workspace_push_events";
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 10_000;
// At 256 identity-only frames, a stalled browser is bounded to a modest amount
// of memory while still allowing short bursts to drain without a full refetch.
const MAX_SUBSCRIBER_QUEUE_SIZE = 256;

interface Subscriber {
  workspaceId: string;
  queue: PushEvent[];
  resolve?: (result: IteratorResult<PushEvent>) => void;
  closed: boolean;
  resyncRequired: boolean;
}

interface ReadyWaiter {
  resolve(): void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export class PostgresWorkspaceEventBus implements WorkspaceEventBus {
  #client?: Client;
  #closed = false;
  #connecting = false;
  #reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  #reconnectTimer?: NodeJS.Timeout;
  #hasConnected = false;
  readonly #subscribers = new Set<Subscriber>();
  readonly #readyWaiters = new Set<ReadyWaiter>();

  constructor(
    private readonly database: Database,
    private readonly logger: AppLogger,
    private readonly telemetryService?: Pick<TelemetryService, "emit">,
  ) {}

  async publish(event: WorkspaceEventPublish): Promise<void> {
    try {
      // json_build_object cannot infer bind-parameter types (42P18), so every
      // parameter carries an explicit ::text cast.
      await sql`
        select pg_notify(
          'workspace_push_events',
          json_build_object(
            'resourceType', ${event.resourceType}::text,
            'resourceId', ${event.resourceId}::text,
            'workspaceId', ${event.workspaceId}::text,
            'changeKind', ${event.changeKind}::text,
            'version', nextval('workspace_push_version_seq')
          )::text
        )
      `.execute(this.database.kysely);
      this.#emitTelemetry("workspace_push.event_published", {
        tags: { change_kind: event.changeKind },
      });
    } catch (error) {
      this.#emitTelemetry("workspace_push.publish_failed", {
        severity: "warn",
        tags: { change_kind: event.changeKind },
      });
      this.logger.warn({
        resourceType: event.resourceType,
        changeKind: event.changeKind,
        err: error,
      }, "Workspace push event publish failed");
    }
  }

  /**
   * Resolves once the LISTEN connection is active, so a caller can order a
   * "refetch now" signal after the point where no further events can be lost.
   * Callers should cap the wait: while the database is unreachable this keeps
   * pending until the reconnect loop succeeds (or the bus closes).
   */
  async ready(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#client || this.#closed || options.signal?.aborted) {
      return;
    }
    void this.#connect();
    await new Promise<void>((resolve) => {
      const waiter: ReadyWaiter = { resolve };
      const cleanup = () => {
        this.#readyWaiters.delete(waiter);
        if (waiter.signal && waiter.abortListener) {
          waiter.signal.removeEventListener("abort", waiter.abortListener);
        }
      };
      waiter.resolve = () => {
        cleanup();
        resolve();
      };
      waiter.signal = options.signal;
      waiter.abortListener = () => waiter.resolve();
      this.#readyWaiters.add(waiter);
      options.signal?.addEventListener("abort", waiter.abortListener, { once: true });
      if (options.signal?.aborted) {
        waiter.resolve();
      }
    });
  }

  subscribe(workspaceId: string): WorkspaceEventSubscription {
    // Publish-only processes (workers) never subscribe; the LISTEN connection is
    // opened lazily so they do not hold an idle client against the shared database.
    void this.#connect();
    const subscriber: Subscriber = {
      workspaceId,
      queue: [],
      closed: false,
      resyncRequired: false,
    };
    this.#subscribers.add(subscriber);

    const close = () => {
      if (subscriber.closed) {
        return;
      }
      subscriber.closed = true;
      this.#subscribers.delete(subscriber);
      subscriber.resolve?.({ done: true, value: undefined });
      subscriber.resolve = undefined;
    };

    return {
      consumeResync: () => {
        const resyncRequired = subscriber.resyncRequired;
        subscriber.resyncRequired = false;
        return resyncRequired;
      },
      [Symbol.asyncIterator](): AsyncIterator<PushEvent> {
        return {
          next: async () => {
            if (subscriber.closed) {
              return { done: true, value: undefined };
            }
            const next = subscriber.queue.shift();
            if (next) {
              return { done: false, value: next };
            }
            return new Promise<IteratorResult<PushEvent>>((resolve) => {
              subscriber.resolve = resolve;
            });
          },
          return: async () => {
            close();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#resolveReadyWaiters();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    for (const subscriber of [...this.#subscribers]) {
      subscriber.closed = true;
      subscriber.resolve?.({ done: true, value: undefined });
      subscriber.resolve = undefined;
      this.#subscribers.delete(subscriber);
    }
    const client = this.#client;
    this.#client = undefined;
    if (client) {
      await client.end().catch(() => undefined);
    }
  }

  async #connect(): Promise<void> {
    if (this.#closed || this.#connecting || this.#client) {
      return;
    }
    this.#connecting = true;
    const client = this.database.createListenerClient();
    client.on("notification", (message) => {
      if (message.channel !== CHANNEL || !message.payload) {
        return;
      }
      this.#emitTelemetry("workspace_push.listener_notification_received");
      const parsed = parsePushEvent(message.payload);
      if (parsed) {
        this.#dispatch(parsed);
      } else {
        this.#emitTelemetry("workspace_push.listener_payload_parse_failed", { severity: "warn" });
      }
    });
    client.on("error", (error) => this.#handleListenerFailure(client, error));
    client.on("end", () => this.#handleListenerFailure(client));

    try {
      await client.connect();
      if (this.#closed) {
        await client.end();
        return;
      }
      // Raw LISTEN intentionally remains in this shared infra adapter; it is allowlisted.
      await client.query(`LISTEN ${CHANNEL}`);
      this.#client = client;
      this.#reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      this.#resolveReadyWaiters();
      this.#emitTelemetry(this.#hasConnected
        ? "workspace_push.listener_reconnected"
        : "workspace_push.listener_connected");
      this.#hasConnected = true;
      this.logger.info({ channel: CHANNEL }, "Workspace push listener connected");
    } catch (error) {
      await client.end().catch(() => undefined);
      this.#handleListenerFailure(client, error);
    } finally {
      this.#connecting = false;
    }
  }

  #handleListenerFailure(client: Client, error?: unknown): void {
    if (this.#closed || this.#reconnectTimer) {
      return;
    }
    if (this.#client && this.#client !== client) {
      return;
    }
    const wasConnected = this.#client === client;
    this.#client = undefined;
    void client.end().catch(() => undefined);
    if (wasConnected) {
      this.#emitTelemetry("workspace_push.listener_disconnected", { severity: "warn" });
    }
    this.logger.warn({ channel: CHANNEL, err: error }, "Workspace push listener reconnecting");
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #dispatch(event: PushEvent): void {
    for (const subscriber of this.#subscribers) {
      if (subscriber.closed || subscriber.workspaceId !== event.workspaceId) {
        continue;
      }
      if (subscriber.resolve) {
        const resolve = subscriber.resolve;
        subscriber.resolve = undefined;
        resolve({ done: false, value: event });
      } else if (subscriber.queue.length >= MAX_SUBSCRIBER_QUEUE_SIZE) {
        subscriber.queue.length = 0;
        subscriber.queue.push(event);
        subscriber.resyncRequired = true;
        this.#emitTelemetry("workspace_push.subscriber_queue_overflow", { severity: "warn" });
      } else {
        subscriber.queue.push(event);
      }
    }
  }

  #emitTelemetry(
    eventType: string,
    input: Omit<Parameters<TelemetryService["emit"]>[0], "eventType"> = {},
  ): void {
    void this.telemetryService?.emit({ eventType, ...input });
  }

  #resolveReadyWaiters(): void {
    for (const waiter of [...this.#readyWaiters]) {
      waiter.resolve();
    }
  }
}

const parsePushEvent = (payload: string): PushEvent | null => {
  try {
    const parsed = pushEventSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
