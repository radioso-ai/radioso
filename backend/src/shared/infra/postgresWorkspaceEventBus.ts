import { sql } from "kysely";
import type { Client } from "pg";

import type { WorkspaceEventBus, WorkspaceEventPublish, PushEvent } from "../events/workspaceEventBus.js";
import { pushEventSchema } from "../events/workspaceEventBus.js";
import type { AppLogger } from "../observability/logger.js";
import type { Database } from "./database.js";

const CHANNEL = "workspace_push_events";
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 10_000;

interface Subscriber {
  workspaceId: string;
  queue: PushEvent[];
  resolve?: (result: IteratorResult<PushEvent>) => void;
  closed: boolean;
}

export class PostgresWorkspaceEventBus implements WorkspaceEventBus {
  #client?: Client;
  #closed = false;
  #connecting = false;
  #reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  #reconnectTimer?: NodeJS.Timeout;
  readonly #subscribers = new Set<Subscriber>();

  constructor(
    private readonly database: Database,
    private readonly logger: AppLogger,
  ) {}

  async publish(event: WorkspaceEventPublish): Promise<void> {
    try {
      await sql`
        select pg_notify(
          'workspace_push_events',
          json_build_object(
            'resourceType', ${event.resourceType},
            'resourceId', ${event.resourceId},
            'workspaceId', ${event.workspaceId},
            'changeKind', ${event.changeKind},
            'version', nextval('workspace_push_version_seq')
          )::text
        )
      `.execute(this.database.kysely);
    } catch (error) {
      this.logger.warn({
        resourceType: event.resourceType,
        changeKind: event.changeKind,
        err: error,
      }, "Workspace push event publish failed");
    }
  }

  subscribe(workspaceId: string): AsyncIterable<PushEvent> {
    // Publish-only processes (workers) never subscribe; the LISTEN connection is
    // opened lazily so they do not hold an idle client against the shared database.
    void this.#connect();
    const subscriber: Subscriber = { workspaceId, queue: [], closed: false };
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
      const parsed = parsePushEvent(message.payload);
      if (parsed) {
        this.#dispatch(parsed);
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
    this.#client = undefined;
    void client.end().catch(() => undefined);
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
      } else {
        subscriber.queue.push(event);
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
