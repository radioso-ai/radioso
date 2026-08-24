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
const STABLE_LISTENER_MS = 10_000;
// At 256 identity-only frames, a stalled browser is bounded to a modest amount
// of memory while still allowing short bursts to drain without a full refetch.
const MAX_SUBSCRIBER_QUEUE_SIZE = 256;
const MAX_PENDING_PUBLISHES = 1_024;

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
  #connectingClient?: Client;
  #closed = false;
  #connecting = false;
  #reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  #reconnectTimer?: NodeJS.Timeout;
  #hasConnected = false;
  #listenerConnectedAt?: number;
  readonly #subscribersByWorkspace = new Map<string, Set<Subscriber>>();
  readonly #readyWaiters = new Set<ReadyWaiter>();
  readonly #pendingPublishes = new Map<string, WorkspaceEventPublish>();
  #publishDrain?: Promise<void>;
  #publishRetryAt = 0;
  #publishRetryDelayMs = INITIAL_RECONNECT_DELAY_MS;
  #lastQueueOverflowTelemetryAt = 0;

  constructor(
    private readonly database: Database,
    private readonly logger: AppLogger,
    private readonly telemetryService?: Pick<TelemetryService, "emit">,
    private readonly notificationPublisher?: (events: readonly WorkspaceEventPublish[]) => Promise<void>,
  ) {}

  async publish(event: WorkspaceEventPublish): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (Date.now() < this.#publishRetryAt) {
      return;
    }
    const key = `${event.workspaceId}\u0000${event.changeKind}`;
    if (this.#pendingPublishes.has(key)) {
      // Delete before set so insertion order continues to represent recency.
      this.#pendingPublishes.delete(key);
    } else if (this.#pendingPublishes.size >= MAX_PENDING_PUBLISHES) {
      const oldestKey = this.#pendingPublishes.keys().next().value as string | undefined;
      if (oldestKey) {
        this.#pendingPublishes.delete(oldestKey);
      }
      if (Date.now() - this.#lastQueueOverflowTelemetryAt >= 60_000) {
        this.#lastQueueOverflowTelemetryAt = Date.now();
        this.#emitTelemetry("workspace_push.publisher_queue_overflow", { severity: "warn" });
      }
    }
    this.#pendingPublishes.set(key, event);
    this.#schedulePublishDrain();
  }

  async #publishBatch(events: readonly WorkspaceEventPublish[]): Promise<boolean> {
    try {
      if (this.notificationPublisher) {
        await this.notificationPublisher(events);
        this.#publishRetryDelayMs = INITIAL_RECONNECT_DELAY_MS;
        return true;
      }
      const batchJson = JSON.stringify(events.map((event) => ({
        resource_type: event.resourceType,
        resource_id: event.resourceId,
        workspace_id: event.workspaceId,
        change_kind: event.changeKind,
      })));
      // A whole coalesced burst is one pool round-trip. PostgreSQL still emits
      // one identity-only notification per row (with its own sequence version).
      await sql`
        select pg_notify(
          'workspace_push_events',
          json_build_object(
            'resourceType', event_data.resource_type,
            'resourceId', event_data.resource_id,
            'workspaceId', event_data.workspace_id,
            'changeKind', event_data.change_kind,
            'version', nextval('workspace_push_version_seq')
          )::text
        )
        from jsonb_to_recordset(${batchJson}::jsonb) as event_data(
          resource_type text,
          resource_id text,
          workspace_id text,
          change_kind text
        )
      `.execute(this.database.kysely);
      this.#publishRetryDelayMs = INITIAL_RECONNECT_DELAY_MS;
      return true;
    } catch (error) {
      this.#publishRetryAt = Date.now() + this.#publishRetryDelayMs;
      this.#publishRetryDelayMs = Math.min(this.#publishRetryDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      this.#emitTelemetry("workspace_push.publish_failed", {
        severity: "warn",
        tags: {
          change_kind: events.every((event) => event.changeKind === events[0]?.changeKind)
            ? events[0]!.changeKind
            : "mixed",
        },
      });
      this.logger.warn({
        batchSize: events.length,
        err: error,
      }, "Workspace push event batch publish failed");
      return false;
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
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    void this.#connect();
    const subscriber: Subscriber = {
      workspaceId,
      queue: [],
      closed: false,
      resyncRequired: false,
    };
    const workspaceSubscribers = this.#subscribersByWorkspace.get(workspaceId) ?? new Set<Subscriber>();
    workspaceSubscribers.add(subscriber);
    this.#subscribersByWorkspace.set(workspaceId, workspaceSubscribers);

    const close = () => {
      if (subscriber.closed) {
        return;
      }
      subscriber.closed = true;
      workspaceSubscribers.delete(subscriber);
      if (workspaceSubscribers.size === 0) {
        this.#subscribersByWorkspace.delete(workspaceId);
      }
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
    this.#pendingPublishes.clear();
    this.#resolveReadyWaiters();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#terminateSubscribers();
    const client = this.#client;
    this.#client = undefined;
    const connectingClient = this.#connectingClient;
    this.#connectingClient = undefined;
    if (client) {
      await client.end().catch(() => undefined);
    }
    if (connectingClient && connectingClient !== client) {
      await connectingClient.end().catch(() => undefined);
    }
  }

  async #connect(): Promise<void> {
    if (this.#closed || this.#connecting || this.#client) {
      return;
    }
    this.#connecting = true;
    const client = this.database.createListenerClient();
    this.#connectingClient = client;
    client.on("notification", (message) => {
      if (message.channel !== CHANNEL || !message.payload) {
        return;
      }
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
      this.#listenerConnectedAt = Date.now();
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
      if (this.#connectingClient === client) {
        this.#connectingClient = undefined;
      }
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
    const wasStable = this.#listenerConnectedAt !== undefined
      && Date.now() - this.#listenerConnectedAt >= STABLE_LISTENER_MS;
    this.#listenerConnectedAt = undefined;
    if (wasConnected) {
      this.#emitTelemetry("workspace_push.listener_disconnected", { severity: "warn" });
    }
    // LISTEN/NOTIFY has no replay. End every current iterator (including one
    // opened while the initial LISTEN was failing) so each browser reconnects
    // and receives a fresh `ready` reconciliation signal.
    this.#terminateSubscribers();
    this.logger.warn({ channel: CHANNEL, err: error }, "Workspace push listener reconnecting");
    if (wasStable) {
      this.#reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    }
    const delay = Math.round(this.#reconnectDelayMs * (0.5 + Math.random()));
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #dispatch(event: PushEvent): void {
    const workspaceSubscribers = this.#subscribersByWorkspace.get(event.workspaceId);
    if (!workspaceSubscribers) {
      return;
    }
    for (const subscriber of workspaceSubscribers) {
      if (subscriber.closed) {
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

  #terminateSubscribers(): void {
    for (const workspaceSubscribers of this.#subscribersByWorkspace.values()) {
      for (const subscriber of workspaceSubscribers) {
        subscriber.closed = true;
        subscriber.resolve?.({ done: true, value: undefined });
        subscriber.resolve = undefined;
      }
    }
    this.#subscribersByWorkspace.clear();
  }

  #schedulePublishDrain(): void {
    if (this.#publishDrain || this.#closed) {
      return;
    }
    const drain = this.#drainPublishes().finally(() => {
      if (this.#publishDrain === drain) {
        this.#publishDrain = undefined;
      }
      if (this.#pendingPublishes.size > 0 && !this.#closed) {
        this.#schedulePublishDrain();
      }
    });
    this.#publishDrain = drain;
  }

  async #drainPublishes(): Promise<void> {
    while (!this.#closed && this.#pendingPublishes.size > 0) {
      const batch = [...this.#pendingPublishes.values()];
      this.#pendingPublishes.clear();
      if (!await this.#publishBatch(batch)) {
        // The channel is lossy by design. Drop the remaining batch after a
        // transport failure instead of hammering the pool once per queued key;
        // reconcile polling restores authoritative state.
        this.#pendingPublishes.clear();
        return;
      }
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
