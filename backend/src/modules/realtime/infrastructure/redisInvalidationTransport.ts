import {
  TRANSPORT_ENVELOPE_MAX_BYTES,
  parseTransportEnvelope,
  workspaceChannel,
  workspaceInvalidationEnvelopeSchema,
  type WorkspaceInvalidationEnvelope,
} from "@radioso/workspace-invalidation-contract";
import { createClient, createCluster } from "redis";
import type {
  WorkspaceInterestContinuity,
  WorkspaceInterestContinuityListener,
  WorkspaceInterestContinuitySource,
  WorkspaceInterestTransport,
  WorkspaceInvalidationListener,
  WorkspaceInvalidationTransport,
} from "../domain/contracts.js";

export type RedisTransportMode = "standalone" | "redis-cluster";
/** IAM auth is token-only: the adapter always uses Redis's default username. */
export type RedisCredentialsProvider = () => Promise<{ password: string }>;
export type RedisLogicalClientRole = "publisher" | "subscriber";

/** Node-redis is structural only at this adapter edge; domain code never sees it. */
export interface RedisLogicalClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  destroy(): void;
  on(event: "error" | "ready" | "reconnecting" | "end", listener: (...args: never[]) => void): void;
  publish?(channel: string, payload: string): Promise<number>;
  sPublish?(channel: string, payload: string): Promise<number>;
  subscribe?(channel: string, listener: RedisMessageListener): Promise<void>;
  sSubscribe?(channel: string, listener: RedisMessageListener): Promise<void>;
  unsubscribe?(channel: string): Promise<void>;
  sUnsubscribe?(channel: string): Promise<void>;
  withCommandOptions(options: { abortSignal: AbortSignal; timeout: number }): Pick<RedisLogicalClient, "publish" | "sPublish">;
}

export type RedisMessageListener = (payload: Uint8Array | string, channel: string) => void;
export type RedisLogicalClientFactory = (input: {
  commandTimeoutMs: number;
  credentialsProvider?: RedisCredentialsProvider;
  disableOfflineQueue: true;
  mode: RedisTransportMode;
  role: RedisLogicalClientRole;
}) => RedisLogicalClient;

/**
 * `bufferMode` preserves message bytes, but node-redis also returns the channel
 * as a Buffer. Convert that provider detail at this edge; an invalid channel is
 * not a valid transport message and is deliberately dropped.
 */
const forwardNodeRedisMessage = (listener: RedisMessageListener) => (payload: string | Buffer, channel: string | Buffer): void => {
  if (typeof channel === "string") {
    listener(payload, channel);
    return;
  }
  try {
    listener(payload, new TextDecoder("utf-8", { fatal: true }).decode(channel));
  } catch {
    // Do not let malformed provider metadata crash the subscription callback.
  }
};

/** Construction stays here so node-redis's broad types never cross this module boundary. */
export const createNodeRedisClientFactory = (input: {
  connectTimeoutMs: number;
  credentialsProvider?: RedisCredentialsProvider;
  queuedCommands: number;
  seeds: readonly string[];
  tls: boolean;
  url?: string;
}): RedisLogicalClientFactory => (request) => {
  const credentialsProvider = input.credentialsProvider
    ? {
      type: "async-credentials-provider" as const,
      credentials: async () => {
        const credentials = await input.credentialsProvider!();
        return { password: credentials.password, username: "default" };
      },
    }
    : undefined;
  const options = {
    commandsQueueMaxLength: input.queuedCommands,
    credentialsProvider,
    disableOfflineQueue: request.disableOfflineQueue,
    socket: input.tls ? { connectTimeout: input.connectTimeoutMs, tls: true as const } : { connectTimeout: input.connectTimeoutMs },
  };
  const client = request.mode === "standalone"
    ? createClient({ ...options, url: input.url })
    : createCluster({
      commandOptions: { timeout: request.commandTimeoutMs },
      defaults: options,
      minimizeConnections: true,
      rootNodes: input.seeds.map((url) => ({ url })),
    });
  const node = client as unknown as {
    connect(): Promise<void>;
    close(): Promise<void>;
    destroy(): void;
    on(event: string, listener: () => void): void;
    publish(channel: string, payload: string): Promise<number>;
    sPublish(channel: string, payload: string): Promise<number>;
    subscribe(channel: string, listener: (payload: string | Buffer, channel: string | Buffer) => void, bufferMode?: boolean): Promise<void>;
    sSubscribe(channel: string, listener: (payload: string | Buffer, channel: string | Buffer) => void, bufferMode?: boolean): Promise<void>;
    unsubscribe(channel: string): Promise<void>;
    sUnsubscribe(channel: string): Promise<void>;
    withCommandOptions(options: { abortSignal: AbortSignal; timeout: number }): unknown;
  };
  const messageForwarders = new WeakMap<RedisMessageListener, (payload: string | Buffer, channel: string | Buffer) => void>();
  const forwardMessage = (listener: RedisMessageListener) => {
    let forwarder = messageForwarders.get(listener);
    if (!forwarder) {
      forwarder = forwardNodeRedisMessage(listener);
      messageForwarders.set(listener, forwarder);
    }
    return forwarder;
  };
  return {
    connect: () => node.connect(),
    close: () => node.close(),
    destroy: () => node.destroy(),
    on: (event, listener) => node.on(event, listener),
    withCommandOptions: (options) => {
      const scoped = node.withCommandOptions(options) as typeof node;
      return {
        publish: (channel, payload) => scoped.publish(channel, payload),
        sPublish: (channel, payload) => scoped.sPublish(channel, payload),
      };
    },
    ...(request.mode === "standalone"
      ? {
        publish: (channel, payload) => node.publish(channel, payload),
        subscribe: (channel, listener) => node.subscribe(channel, forwardMessage(listener), true),
        unsubscribe: (channel) => node.unsubscribe(channel),
      }
      : {
        sPublish: (channel, payload) => node.sPublish(channel, payload),
        sSubscribe: (channel, listener) => node.sSubscribe(channel, forwardMessage(listener), true),
        sUnsubscribe: (channel) => node.sUnsubscribe(channel),
      }),
  };
};

type Interest = {
  attachedEpoch: number | undefined;
  brokerAttached: boolean;
  desiredRevision: number;
  listener: RedisMessageListener;
  listeners: Set<WorkspaceInvalidationListener>;
  queue: Promise<void>;
  uncertainRemote: boolean;
  workspaceId: string;
};

const abortError = () => Object.assign(new Error("Realtime Redis command aborted"), { name: "AbortError" });

const withDeadline = async <T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> => {
  if (signal?.aborted) throw abortError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let detachAbort: () => void = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Realtime Redis command timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
      new Promise<T>((_resolve, reject) => {
        if (!signal) return;
        const onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    detachAbort();
  }
};

/**
 * Redis/Valkey transport for transient workspace invalidations. It retains only
 * local callback sets; Redis is never a source of authoritative state.
 */
type RedisTransportInput = {
  channelPrefix: string;
  commandTimeoutMs: number;
  createClient: RedisLogicalClientFactory;
  credentialsProvider?: RedisCredentialsProvider;
  mode: RedisTransportMode;
  maxWorkspaceInterests?: number;
  restoreRetryBaseMs?: number;
  restoreRetryJitter?: () => number;
  restoreRetryMaxMs?: number;
  telemetry?: { event(outcome: "connected" | "reconnect" | "failed"): void };
};

class RedisClientLifecycle {
  private closePromise: Promise<void> | undefined;
  private readonly destroyedClients = new WeakSet<RedisLogicalClient>();
  private lifecycle: "new" | "ready" | "closed" = "new";
  private startAbortController: AbortController | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(
    private readonly input: RedisTransportInput,
    private readonly role: RedisLogicalClientRole,
    private readonly onClient: (client: RedisLogicalClient) => void,
  ) {}

  async start(): Promise<void> {
    this.requireOpen();
    if (this.lifecycle === "ready") return;
    if (!this.startPromise) {
      const abortController = new AbortController();
      this.startAbortController = abortController;
      this.startPromise = this.open(abortController.signal)
        .finally(() => {
          if (this.startAbortController === abortController) this.startAbortController = undefined;
        })
        .catch((error) => {
          this.startPromise = undefined;
          throw error;
        });
    }
    await this.startPromise;
  }

  client(): RedisLogicalClient {
    if (!this.clientValue) throw new Error(`Realtime Redis ${this.role} is not initialized`);
    return this.clientValue;
  }

  isClosed(): boolean {
    return this.lifecycle === "closed";
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycle = "closed";
    this.startAbortController?.abort();
    const client = this.clientValue;
    this.closePromise = client ? this.closeClient(client).then(() => undefined) : Promise.resolve();
    return this.closePromise;
  }

  private clientValue: RedisLogicalClient | undefined;

  private async open(signal: AbortSignal): Promise<void> {
    const client = this.input.createClient({
      commandTimeoutMs: this.input.commandTimeoutMs,
      credentialsProvider: this.input.credentialsProvider,
      disableOfflineQueue: true as const,
      mode: this.input.mode,
      role: this.role,
    });
    this.clientValue = client;
    this.onClient(client);
    try {
      await withDeadline(client.connect(), this.input.commandTimeoutMs, signal);
      if (this.closePromise) return;
      this.lifecycle = "ready";
      this.input.telemetry?.event("connected");
    } catch (error) {
      if (!this.closePromise) {
        const forced = await this.closeClient(client);
        if (!forced) this.input.telemetry?.event("failed");
      }
      throw error;
    }
  }

  private async closeClient(client: RedisLogicalClient): Promise<boolean> {
    let close: Promise<void>;
    try {
      close = client.close();
    } catch {
      return this.destroyOnce(client);
    }
    void close.catch(() => undefined);
    try {
      await withDeadline(close, this.input.commandTimeoutMs);
      return false;
    } catch {
      return this.destroyOnce(client);
    }
  }

  private destroyOnce(client: RedisLogicalClient): boolean {
    if (this.destroyedClients.has(client)) return false;
    this.destroyedClients.add(client);
    this.input.telemetry?.event("failed");
    try {
      client.destroy();
    } catch {
      // Shutdown is already fenced; forceful provider cleanup is best effort.
    }
    return true;
  }

  private requireOpen(): void {
    if (this.lifecycle === "closed") throw new Error("Realtime Redis transport is closed");
  }
}

/** Producer-process adapter: creates exactly one publisher logical client. */
export class RedisInvalidationPublisher implements WorkspaceInvalidationTransport {
  private readonly lifecycle: RedisClientLifecycle;

  constructor(private readonly input: RedisTransportInput) {
    this.lifecycle = new RedisClientLifecycle(input, "publisher", (client) => {
      client.on("error", () => this.input.telemetry?.event("failed"));
    });
  }

  async publish(envelope: WorkspaceInvalidationEnvelope, options: { signal: AbortSignal }): Promise<void> {
    const parsed = workspaceInvalidationEnvelopeSchema.parse(envelope);
    const payload = JSON.stringify(parsed);
    if (new TextEncoder().encode(payload).byteLength > TRANSPORT_ENVELOPE_MAX_BYTES) {
      throw new Error("Workspace invalidation transport envelope exceeds byte cap");
    }
    await this.lifecycle.start();
    const publisher = this.lifecycle.client().withCommandOptions({ abortSignal: options.signal, timeout: this.input.commandTimeoutMs });
    const command = this.input.mode === "redis-cluster"
      ? publisher.sPublish?.(workspaceChannel(this.input.channelPrefix, parsed.workspaceId), payload)
      : publisher.publish?.(workspaceChannel(this.input.channelPrefix, parsed.workspaceId), payload);
    if (!command) throw new Error("Redis publisher does not support configured Pub/Sub mode");
    await withDeadline(command, this.input.commandTimeoutMs, options.signal);
  }

  close(): Promise<void> {
    return this.lifecycle.close();
  }
}

/** Gateway-process adapter: creates exactly one subscriber logical client. */
export class RedisWorkspaceInterestSubscriber implements WorkspaceInterestTransport, WorkspaceInterestContinuitySource {
  private continuityGeneration = 0;
  private readonly continuityListeners = new Set<WorkspaceInterestContinuityListener>();
  private desiredRevision = 0;
  private readonly interests = new Map<string, Interest>();
  private readonly lifecycle: RedisClientLifecycle;
  private restorePromise: Promise<void> | undefined;
  private restoreEpoch = 0;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private socketReady = false;
  private transportLost = false;

  constructor(private readonly input: RedisTransportInput) {
    this.lifecycle = new RedisClientLifecycle(input, "subscriber", (client) => {
      client.on("error", () => this.markLost());
      client.on("reconnecting", () => this.markLost());
      client.on("end", () => this.markLost());
      client.on("ready", () => {
        this.socketReady = true;
        this.restoreAfterReady();
      });
    });
  }

  start(): Promise<void> {
    const starting = this.lifecycle.start().then(() => {
      this.socketReady = true;
    });
    void starting.catch(() => undefined);
    return starting;
  }

  onContinuity(listener: WorkspaceInterestContinuityListener): () => void {
    this.continuityListeners.add(listener);
    return () => this.continuityListeners.delete(listener);
  }

  async subscribe(workspaceId: string, listener: WorkspaceInvalidationListener): Promise<{ generation: number }> {
    await this.start();
    let interest = this.interests.get(workspaceId);
    if (!interest) {
      if (this.interests.size >= this.maxWorkspaceInterests()) throw new Error("Realtime Redis workspace interest capacity exceeded");
      interest = this.createInterest(workspaceId);
      this.interests.set(workspaceId, interest);
    }
    interest.listeners.add(listener);
    interest.desiredRevision += 1;
    this.desiredRevision += 1;
    try {
      if (this.transportLost) {
        await this.waitForCurrentRestore();
      }
      await this.reconcile(workspaceId, interest);
      return { generation: this.continuityGeneration };
    } catch (error) {
      // A rejected admission to a lost generation must not retain a callback
      // that can later be revived by restoration.
      if (interest.listeners.delete(listener)) {
        interest.desiredRevision += 1;
        this.desiredRevision += 1;
      }
      this.dropEmptyCertainInterest(workspaceId, interest);
      throw error;
    }
  }

  async unsubscribe(workspaceId: string, listener: WorkspaceInvalidationListener): Promise<void> {
    const interest = this.interests.get(workspaceId);
    if (!interest || !interest.listeners.delete(listener)) return;
    interest.desiredRevision += 1;
    this.desiredRevision += 1;
    // The callback is detached synchronously before any remote acknowledgement.
    await this.reconcile(workspaceId, interest);
  }

  close(): Promise<void> {
    this.cancelReconciliationRetry();
    this.interests.clear();
    return this.lifecycle.close();
  }

  private createInterest(workspaceId: string): Interest {
    const listeners = new Set<WorkspaceInvalidationListener>();
    return {
      attachedEpoch: undefined,
      brokerAttached: false,
      desiredRevision: 0,
      listener: (payload, actualChannel) => this.onMessage(workspaceId, actualChannel, payload),
      listeners,
      queue: Promise.resolve(),
      uncertainRemote: false,
      workspaceId,
    };
  }

  private reconcile(workspaceId: string, interest: Interest): Promise<void> {
    const run = async () => {
      if (this.lifecycle.isClosed() || this.interests.get(workspaceId) !== interest) return;
      const channel = workspaceChannel(this.input.channelPrefix, workspaceId);
      if (interest.uncertainRemote) {
        try {
          await this.brokerUnsubscribe(channel);
          interest.uncertainRemote = false;
          interest.brokerAttached = false;
          interest.attachedEpoch = undefined;
        } catch (error) {
          this.markUncertain();
          throw error;
        }
      }
      if (interest.listeners.size > 0 && !interest.brokerAttached) {
        try {
          await this.brokerSubscribe(channel, interest.listener);
          if (this.lifecycle.isClosed() || this.interests.get(workspaceId) !== interest) return;
          interest.brokerAttached = true;
        } catch (error) {
          interest.uncertainRemote = true;
          this.markUncertain();
          throw error;
        }
        return;
      }
      if (interest.listeners.size === 0 && (interest.brokerAttached || interest.uncertainRemote)) {
        interest.brokerAttached = false;
        try {
          await this.brokerUnsubscribe(channel);
          interest.uncertainRemote = false;
          interest.attachedEpoch = undefined;
        } catch (error) {
          interest.uncertainRemote = true;
          this.markUncertain();
          throw error;
        }
      }
      this.dropEmptyCertainInterest(workspaceId, interest);
    };
    interest.queue = interest.queue.catch(() => undefined).then(run);
    return interest.queue;
  }

  private onMessage(workspaceId: string, actualChannel: string, payload: Uint8Array | string): void {
    if (actualChannel !== workspaceChannel(this.input.channelPrefix, workspaceId)) return;
    let envelope: WorkspaceInvalidationEnvelope;
    try {
      envelope = parseTransportEnvelope(payload);
    } catch {
      return;
    }
    if (envelope.workspaceId !== workspaceId) return;
    for (const listener of this.interests.get(workspaceId)?.listeners ?? []) listener(envelope.changeKinds);
  }

  private markLost(): void {
    if (this.lifecycle.isClosed()) return;
    this.restoreEpoch += 1;
    this.socketReady = false;
    this.cancelReconciliationRetry();
    if (this.transportLost) return;
    this.transportLost = true;
    this.continuityGeneration += 1;
    this.input.telemetry?.event("reconnect");
    this.emitContinuity({ generation: this.continuityGeneration, state: "lost" });
  }

  private restoreAfterReady(): void {
    if (!this.transportLost || !this.socketReady || this.lifecycle.isClosed() || this.restorePromise) return;
    const generation = this.continuityGeneration;
    const epoch = this.restoreEpoch;
    let stale = false;
    this.restorePromise = (async () => {
      while (true) {
        const desiredRevision = this.desiredRevision;
        for (const interest of this.interests.values()) {
          if (!interest.uncertainRemote) continue;
          await this.brokerUnsubscribe(workspaceChannel(this.input.channelPrefix, interest.workspaceId));
          interest.uncertainRemote = false;
          interest.brokerAttached = false;
          interest.attachedEpoch = undefined;
          this.dropEmptyCertainInterest(interest.workspaceId, interest);
        }
        if (this.lifecycle.isClosed() || generation !== this.continuityGeneration || epoch !== this.restoreEpoch) {
          stale = true;
          return;
        }
        for (const [workspaceId, interest] of this.interests) {
          if (interest.listeners.size === 0 || this.interests.get(workspaceId) !== interest) continue;
          if (interest.attachedEpoch === epoch) continue;
          interest.brokerAttached = false;
          // Re-use the per-workspace command queue. This fences a concurrent
          // remove/add behind the exact subscribe acknowledgement rather than
          // allowing a second overlapping subscribe during restoration.
          await this.reconcile(workspaceId, interest);
          if (this.lifecycle.isClosed() || generation !== this.continuityGeneration || epoch !== this.restoreEpoch) {
            stale = true;
            return;
          }
          if (this.interests.get(workspaceId) !== interest || interest.listeners.size === 0) {
            interest.brokerAttached = false;
            interest.attachedEpoch = undefined;
            await this.brokerUnsubscribe(workspaceChannel(this.input.channelPrefix, workspaceId)).catch(() => undefined);
            continue;
          }
          interest.attachedEpoch = epoch;
        }
        const allAttached = [...this.interests.values()].every((interest) => interest.listeners.size === 0 || interest.attachedEpoch === epoch);
        if (this.desiredRevision === desiredRevision && allAttached) {
          if (!this.lifecycle.isClosed() && this.socketReady && generation === this.continuityGeneration && epoch === this.restoreEpoch) {
            this.transportLost = false;
            this.retryAttempt = 0;
            this.input.telemetry?.event("connected");
            this.emitContinuity({ generation, state: "restored" });
          }
          return;
        }
      }
    })().catch(() => {
      this.input.telemetry?.event("failed");
    }).finally(() => {
      this.restorePromise = undefined;
      if (stale && this.transportLost && this.socketReady) this.restoreAfterReady();
      else if (this.transportLost && this.socketReady && !this.lifecycle.isClosed()) this.scheduleReconciliationRetry(epoch);
    });
  }

  private cancelReconciliationRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAttempt = 0;
  }

  private dropEmptyCertainInterest(workspaceId: string, interest: Interest): void {
    if (interest.listeners.size === 0 && !interest.uncertainRemote && this.interests.get(workspaceId) === interest) {
      this.interests.delete(workspaceId);
    }
  }

  private maxWorkspaceInterests(): number {
    return this.input.maxWorkspaceInterests ?? 500;
  }

  private markUncertain(): void {
    if (this.transportLost) return;
    this.input.telemetry?.event("failed");
    this.scheduleReconciliationRetry(this.restoreEpoch);
  }

  private scheduleReconciliationRetry(epoch: number): void {
    if (this.retryTimer || epoch !== this.restoreEpoch || !this.socketReady || this.lifecycle.isClosed()) return;
    const baseMs = this.input.restoreRetryBaseMs ?? 25;
    const maxMs = this.input.restoreRetryMaxMs ?? 1_000;
    const bounded = Math.min(maxMs, baseMs * 2 ** Math.min(this.retryAttempt, 8));
    const random = Math.max(0, Math.min(1, (this.input.restoreRetryJitter ?? Math.random)()));
    const delayMs = Math.min(maxMs, bounded + Math.floor(bounded * random * 0.2));
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.transportLost) {
        this.restoreAfterReady();
      } else {
        void this.pumpHealthyUncertainty();
      }
    }, delayMs);
  }

  private async pumpHealthyUncertainty(): Promise<void> {
    if (this.transportLost || this.lifecycle.isClosed() || !this.socketReady) return;
    try {
      for (const [workspaceId, interest] of this.interests) {
        if (!interest.uncertainRemote || this.interests.get(workspaceId) !== interest) continue;
        await this.reconcile(workspaceId, interest);
      }
      if (![...this.interests.values()].some((interest) => interest.uncertainRemote)) this.retryAttempt = 0;
    } catch {
      this.markUncertain();
    }
  }

  private async waitForCurrentRestore(): Promise<void> {
    const restore = this.restorePromise;
    if (!restore) throw new Error("Realtime Redis subscriber continuity is unavailable");
    await restore;
    if (this.transportLost) throw new Error("Realtime Redis subscriber continuity did not restore");
  }

  private emitContinuity(event: WorkspaceInterestContinuity): void {
    for (const listener of this.continuityListeners) listener(event);
  }

  private brokerSubscribe(channel: string, listener: RedisMessageListener): Promise<void> {
    const subscriber = this.requireSubscriber();
    const command = this.input.mode === "redis-cluster"
      ? subscriber.sSubscribe?.(channel, listener)
      : subscriber.subscribe?.(channel, listener);
    if (!command) return Promise.reject(new Error("Redis subscriber does not support configured Pub/Sub mode"));
    return withDeadline(command, this.input.commandTimeoutMs);
  }

  private brokerUnsubscribe(channel: string): Promise<void> {
    const subscriber = this.requireSubscriber();
    const command = this.input.mode === "redis-cluster"
      ? subscriber.sUnsubscribe?.(channel)
      : subscriber.unsubscribe?.(channel);
    if (!command) return Promise.reject(new Error("Redis subscriber does not support configured Pub/Sub mode"));
    return withDeadline(command, this.input.commandTimeoutMs);
  }

  private requireSubscriber(): RedisLogicalClient {
    return this.lifecycle.client();
  }
}
