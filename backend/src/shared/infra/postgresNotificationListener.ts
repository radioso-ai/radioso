import { Client, type ClientConfig, type Notification } from "pg";

import type { AppLogger } from "../observability/logger.js";

/** What a subscriber hears on one channel. */
export interface NotificationHandlers {
  notification(payload: string): void;
  /**
   * The channel is being listened to: once after subscribing, and again after every reconnect.
   * `mayHaveMissed` is true when notifications sent since the subscriber subscribed, or since its
   * last `interrupted`, may have been lost: it subscribed before this session's LISTEN on the
   * channel took effect, or the connection dropped. It is false when the subscriber joined a channel
   * the session already listened to, so it has heard everything sent since it subscribed.
   */
  listening(state: { mayHaveMissed: boolean }): void;
  /** The connection dropped; nothing is heard until the next `listening`. */
  interrupted(): void;
}

/** The part of a `pg` client the listener uses. */
export interface NotificationClient {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "notification", listener: (message: Notification) => void): unknown;
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<unknown>;
  escapeIdentifier(identifier: string): string;
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
  /**
   * Backoff between reconnect attempts, doubling from `initialMs` up to `maxMs`. Each delay is
   * drawn between half and all of that, so the instances of a deployment that lost the database
   * together come back spread out.
   */
  reconnectDelay?: { initialMs: number; maxMs: number };
  /**
   * How often the idle session proves it still reaches the server, and how long that may take.
   * A session that only listens sends nothing, so a connection cut without a reset would otherwise
   * go unnoticed until the operating system's keepalive gives up, hours later. 0 turns it off.
   */
  healthCheck?: { intervalMs: number; timeoutMs: number };
  logger?: Pick<AppLogger, "info" | "warn">;
  /** Opens the session's client; a `pg` client unless a test hands in its own. */
  createClient?: (config: ClientConfig) => NotificationClient;
  /** Returns a number in [0, 1); injected so a test can pin the reconnect delay. */
  random?: () => number;
}

const DEFAULT_RECONNECT_DELAY = { initialMs: 500, maxMs: 15_000 };
const DEFAULT_HEALTH_CHECK = { intervalMs: 30_000, timeoutMs: 10_000 };
/** TCP keepalive probes start after this much silence, rather than the operating system's two hours. */
const KEEPALIVE_INITIAL_DELAY_MS = 10_000;

// LISTEN takes an identifier, not a parameter; channels are named in code, never from input.
const CHANNEL_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * One dedicated, unpooled Postgres session per process for LISTEN. Postgres delivers each NOTIFY
 * to every session listening on its channel, so the processes of a deployment hear each other
 * through it. The connection opens on the first subscription, reconnects with backoff after it
 * drops or stops answering its health check, and closes once nothing has subscribed for
 * `idleCloseMs`. A channel stays listened to from its first subscriber until the connection
 * closes, so a subscriber that comes back while the connection is open hears everything at once.
 * A transport only: it wakes subscribers and carries no state of its own.
 */
export class PostgresNotificationListener {
  private readonly subscriptions = new Map<string, Set<NotificationHandlers>>();
  private client: NotificationClient | null = null;
  private connecting = false;
  private listened = new Set<string>();
  private readonly retired = new WeakSet<NotificationClient>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
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
          this.safely(() => handlers.listening({ mayHaveMissed: false }));
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
    this.stopHealthCheck();
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
    const createClient = this.options.createClient ?? ((config: ClientConfig) => new Client(config));
    const client = createClient({
      connectionString: this.options.connectionString,
      application_name: this.options.applicationName,
      connectionTimeoutMillis: this.options.connectionTimeoutMs,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
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
        this.startHealthCheck(client);
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

  private async listen(client: NotificationClient, channel: string): Promise<void> {
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
    // Every subscriber here subscribed before this LISTEN took effect, or lost the previous
    // connection: something may have been sent in between.
    for (const handlers of this.subscriptions.get(channel) ?? []) {
      this.safely(() => handlers.listening({ mayHaveMissed: true }));
    }
  }

  private deliver(message: Notification): void {
    for (const handlers of this.subscriptions.get(message.channel) ?? []) {
      this.safely(() => handlers.notification(message.payload ?? ""));
    }
  }

  private lost(client: NotificationClient, error?: Error): void {
    if (this.retired.has(client)) {
      return;
    }
    this.retired.add(client);
    void client.end().catch(() => undefined);
    const wasListening = this.client === client;
    if (wasListening) {
      this.client = null;
      this.listened = new Set();
      this.stopHealthCheck();
    }
    if (this.closed) {
      return;
    }
    this.options.logger?.warn(
      {
        event: "postgres_notification_listener_lost",
        applicationName: this.options.applicationName,
        err: error,
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
    const ceiling = Math.min(maxMs, initialMs * 2 ** this.reconnectAttempt);
    const delay = Math.round(ceiling * (0.5 + 0.5 * (this.options.random ?? Math.random)()));
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
      this.stopHealthCheck();
      void this.retire(client);
    }, this.options.idleCloseMs);
    this.idleTimer.unref();
  }

  /** Proves now and then that the session still reaches the server; a failure counts as a drop. */
  private startHealthCheck(client: NotificationClient): void {
    const { intervalMs, timeoutMs } = this.options.healthCheck ?? DEFAULT_HEALTH_CHECK;
    this.stopHealthCheck();
    if (intervalMs <= 0) {
      return;
    }
    let checking = false;
    this.healthTimer = setInterval(() => {
      if (checking || this.client !== client) {
        return;
      }
      checking = true;
      void this.checkHealth(client, timeoutMs).finally(() => {
        checking = false;
      });
    }, intervalMs);
    this.healthTimer.unref();
  }

  private async checkHealth(client: NotificationClient, timeoutMs: number): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timed_out">((resolve) => {
      timeout = setTimeout(() => resolve("timed_out"), timeoutMs);
      timeout.unref();
    });
    try {
      const outcome = await Promise.race([client.query("SELECT 1").then(() => "answered" as const), timedOut]);
      if (outcome === "timed_out") {
        this.lost(client, new Error(`Health check got no answer within ${timeoutMs} ms`));
      }
    } catch (error) {
      this.lost(client, error instanceof Error ? error : undefined);
    } finally {
      clearTimeout(timeout);
    }
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Ends a connection this listener closed on purpose, so its `end` is not reported as lost. */
  private async retire(client: NotificationClient): Promise<void> {
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
