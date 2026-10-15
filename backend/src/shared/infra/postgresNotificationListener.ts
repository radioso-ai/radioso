import { Client, type Notification } from "pg";

import type { AppLogger } from "../observability/logger.js";

/** What a subscriber hears on one channel. */
export interface NotificationHandlers {
  notification(payload: string): void;
  /**
   * The channel is being listened to: on subscribing, and again after every reconnect.
   * Notifications sent while nothing listened are lost, so a subscriber that keeps state in its
   * tables catches up here.
   */
  listening(): void;
  /** The connection dropped; nothing is heard until the next `listening`. */
  interrupted(): void;
}

interface PostgresNotificationListenerOptions {
  connectionString: string;
  applicationName?: string;
  connectionTimeoutMs?: number;
  /**
   * How long the connection stays open once nothing subscribes, as the pool's idle timeout; 0 keeps
   * it open until `close`.
   */
  idleCloseMs: number;
  /** Backoff between reconnect attempts, doubling from `initialMs` up to `maxMs`. */
  reconnectDelay?: { initialMs: number; maxMs: number };
  logger?: Pick<AppLogger, "info" | "warn">;
}

const DEFAULT_RECONNECT_DELAY = { initialMs: 500, maxMs: 15_000 };

// LISTEN takes an identifier, not a parameter; channels are named in code, never from input.
const CHANNEL_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * One dedicated, unpooled Postgres session per process for LISTEN. Postgres delivers each NOTIFY
 * to every session listening on its channel, so the processes of a deployment hear each other
 * through it. The connection opens on the first subscription, reconnects with backoff after it
 * drops, and closes once nothing has subscribed for `idleCloseMs`. A transport only: it wakes
 * subscribers and carries no state of its own.
 */
export class PostgresNotificationListener {
  private readonly subscriptions = new Map<string, Set<NotificationHandlers>>();
  private client: Client | null = null;
  private connecting = false;
  private listened = new Set<string>();
  private readonly retired = new WeakSet<Client>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly options: PostgresNotificationListenerOptions) {}

  /** Subscribes to `channel`; the returned function unsubscribes. */
  subscribe(channel: string, handlers: NotificationHandlers): () => void {
    if (!CHANNEL_NAME.test(channel)) {
      throw new Error(`Invalid notification channel name: ${channel}`);
    }
    if (this.closed) {
      return () => undefined;
    }
    this.clearIdleTimer();
    const channelHandlers = this.subscriptions.get(channel) ?? new Set<NotificationHandlers>();
    channelHandlers.add(handlers);
    this.subscriptions.set(channel, channelHandlers);

    if (this.client && this.listened.has(channel)) {
      queueMicrotask(() => {
        if (this.subscriptions.get(channel)?.has(handlers) && this.listened.has(channel)) {
          this.safely(() => handlers.listening());
        }
      });
    } else if (this.client) {
      void this.listen(this.client, channel);
    } else {
      this.connect();
    }

    return () => {
      const current = this.subscriptions.get(channel);
      if (!current?.delete(handlers)) {
        return;
      }
      if (current.size === 0) {
        this.subscriptions.delete(channel);
      }
      if (this.subscriptions.size === 0) {
        this.scheduleIdleClose();
      }
    };
  }

  /** Stops reconnecting and ends the connection. */
  async close(): Promise<void> {
    this.closed = true;
    this.subscriptions.clear();
    this.clearIdleTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    this.listened = new Set();
    if (client) {
      await this.retire(client);
    }
  }

  private connect(): void {
    if (this.connecting || this.client || this.closed) {
      return;
    }
    this.connecting = true;
    const client = new Client({
      connectionString: this.options.connectionString,
      application_name: this.options.applicationName,
      connectionTimeoutMillis: this.options.connectionTimeoutMs,
      keepAlive: true,
    });
    client.on("error", (error: Error) => this.lost(client, error));
    client.on("end", () => this.lost(client));
    client.on("notification", (message: Notification) => this.deliver(message));

    void client.connect().then(
      async () => {
        this.connecting = false;
        if (this.closed) {
          await this.retire(client);
          return;
        }
        if (this.retired.has(client)) {
          // It dropped between connecting and this callback; `lost` already scheduled a reconnect.
          return;
        }
        this.client = client;
        this.listened = new Set();
        if (this.reconnectAttempt > 0) {
          this.options.logger?.info(
            { event: "postgres_notification_listener_reconnected", applicationName: this.options.applicationName },
            "Postgres notification listener reconnected",
          );
        }
        this.reconnectAttempt = 0;
        if (this.subscriptions.size === 0) {
          this.scheduleIdleClose();
        }
        await Promise.all([...this.subscriptions.keys()].map((channel) => this.listen(client, channel)));
      },
      (error: unknown) => {
        this.connecting = false;
        this.lost(client, error instanceof Error ? error : undefined);
      },
    );
  }

  private async listen(client: Client, channel: string): Promise<void> {
    try {
      await client.query(`LISTEN ${client.escapeIdentifier(channel)}`);
    } catch (error) {
      this.lost(client, error instanceof Error ? error : undefined);
      return;
    }
    if (this.client !== client || this.listened.has(channel)) {
      return;
    }
    this.listened.add(channel);
    for (const handlers of this.subscriptions.get(channel) ?? []) {
      this.safely(() => handlers.listening());
    }
  }

  private deliver(message: Notification): void {
    for (const handlers of this.subscriptions.get(message.channel) ?? []) {
      this.safely(() => handlers.notification(message.payload ?? ""));
    }
  }

  private lost(client: Client, error?: Error): void {
    if (this.retired.has(client)) {
      return;
    }
    this.retired.add(client);
    void client.end().catch(() => undefined);
    const wasListening = this.client === client;
    if (wasListening) {
      this.client = null;
      this.listened = new Set();
    }
    if (this.closed) {
      return;
    }
    const { code } = (error ?? {}) as { code?: unknown };
    this.options.logger?.warn(
      {
        event: "postgres_notification_listener_lost",
        applicationName: this.options.applicationName,
        code: typeof code === "string" ? code : undefined,
        err: error?.message,
      },
      "Postgres notification listener lost its connection",
    );
    if (wasListening) {
      for (const channelHandlers of this.subscriptions.values()) {
        for (const handlers of channelHandlers) {
          this.safely(() => handlers.interrupted());
        }
      }
    }
    if (this.subscriptions.size > 0) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) {
      return;
    }
    const { initialMs, maxMs } = this.options.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
    const delay = Math.min(maxMs, initialMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscriptions.size > 0) {
        this.connect();
      }
    }, delay);
    this.reconnectTimer.unref();
  }

  private scheduleIdleClose(): void {
    if (this.options.idleCloseMs <= 0 || this.idleTimer) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const client = this.client;
      if (this.subscriptions.size > 0 || !client) {
        return;
      }
      this.client = null;
      this.listened = new Set();
      void this.retire(client);
    }, this.options.idleCloseMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Ends a connection this listener closed on purpose, so its `end` is not reported as lost. */
  private async retire(client: Client): Promise<void> {
    this.retired.add(client);
    await client.end().catch(() => undefined);
  }

  private safely(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.options.logger?.warn(
        {
          event: "postgres_notification_handler_failed",
          applicationName: this.options.applicationName,
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "Postgres notification handler failed",
      );
    }
  }
}
