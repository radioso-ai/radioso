import { createClient, createCluster } from "redis";

import type { RedisCredentialsProvider, RedisTransportMode } from "./redisInvalidationTransport.js";
import type { RedisAdmissionScriptPort } from "./redisAdmissionController.js";
import { redisAdmissionScripts } from "./redisAdmissionScripts.js";

type Health = "ready" | "degraded";

export interface RedisAdmissionCommandClientTelemetry {
  event(outcome: Health): void;
}

type CommandClientClock = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(token: unknown): void;
};

const systemClock: CommandClientClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
};

const abortError = () => Object.assign(new Error("Realtime admission command client startup aborted"), { name: "AbortError" });

type CommandClient = {
  connect(): Promise<void>;
  close(): Promise<void>;
  destroy(): void;
  on(event: "error" | "ready" | "reconnecting" | "end", listener: () => void): void;
  withCommandOptions(options: { timeout: number }): {
    eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  };
};

export class RedisAdmissionCommandClient implements RedisAdmissionScriptPort {
  private readonly client: CommandClient;
  private readonly listeners = new Set<(health: Health) => void>();
  private state: Health = "degraded";
  private lifecycle: "idle" | "starting" | "ready" | "failed" | "closed" = "idle";
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private startReject: ((error: unknown) => void) | undefined;
  private connectTimer: unknown;
  private removeStartAbort: (() => void) | undefined;
  private destroyed = false;

  constructor(private readonly input: {
    mode: RedisTransportMode;
    url?: string;
    seeds: readonly string[];
    tls: boolean;
    queuedCommands: number;
    connectTimeoutMs: number;
    commandTimeoutMs: number;
    credentialsProvider?: RedisCredentialsProvider;
    clock?: CommandClientClock;
    telemetry?: RedisAdmissionCommandClientTelemetry;
  }) {
    const credentialsProvider = input.credentialsProvider
      ? {
        type: "async-credentials-provider" as const,
        credentials: async () => ({ username: "default", ...(await input.credentialsProvider!()) }),
      }
      : undefined;
    const socket = input.tls
      ? { connectTimeout: input.connectTimeoutMs, tls: true as const }
      : { connectTimeout: input.connectTimeoutMs };
    const client = input.mode === "standalone"
      ? createClient({
        url: input.url,
        commandsQueueMaxLength: input.queuedCommands,
        credentialsProvider,
        disableOfflineQueue: true,
        socket,
      })
      : createCluster({
        commandOptions: { timeout: input.commandTimeoutMs },
        defaults: {
          commandsQueueMaxLength: input.queuedCommands,
          credentialsProvider,
          disableOfflineQueue: true,
          socket,
        },
        minimizeConnections: true,
        rootNodes: input.seeds.map((url) => ({ url })),
      });
    this.client = client as unknown as CommandClient;
    this.client.on("error", () => this.update("degraded"));
    this.client.on("reconnecting", () => this.update("degraded"));
    this.client.on("end", () => this.update("degraded"));
    this.client.on("ready", () => this.update("ready"));
  }

  start(signal?: AbortSignal): Promise<void> {
    if (this.lifecycle === "closed" || this.closePromise) return Promise.reject(new Error("Realtime admission command client is closed"));
    if (this.startPromise) return this.startPromise;
    if (signal?.aborted) return Promise.reject(abortError());

    this.lifecycle = "starting";
    const clock = this.input.clock ?? systemClock;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startReject = reject;
      const fail = (error: unknown, destroy: boolean): void => {
        if (this.lifecycle !== "starting") return;
        this.lifecycle = "failed";
        this.cleanupStartFence();
        if (destroy) this.destroyOnce();
        reject(error);
      };
      if (signal) {
        const onAbort = () => fail(abortError(), true);
        signal.addEventListener("abort", onAbort, { once: true });
        this.removeStartAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.connectTimer = clock.setTimeout(
        () => fail(new Error("Realtime admission command client connect timed out"), true),
        this.input.connectTimeoutMs,
      );

      let connecting: Promise<void>;
      try {
        connecting = this.client.connect();
      } catch (error) {
        fail(error, false);
        return;
      }
      connecting.then(
        () => {
          if (this.lifecycle !== "starting") return;
          this.lifecycle = "ready";
          this.cleanupStartFence();
          this.update("ready");
          resolve();
        },
        (error) => fail(error, false),
      );
    });
    return this.startPromise;
  }

  async health(): Promise<Health> {
    if (this.lifecycle === "closed") return "degraded";
    try {
      await this.client.withCommandOptions({ timeout: this.input.commandTimeoutMs }).eval("return redis.call('PING')", { keys: [], arguments: [] });
      this.update("ready");
    } catch {
      this.update("degraded");
    }
    return this.state;
  }

  onHealth(listener: (health: Health) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  execute(name: string, keys: readonly string[], args: readonly string[]): Promise<unknown> {
    if (this.lifecycle === "closed") return Promise.reject(new Error("Realtime admission command client is closed"));
    const script = name === "admission.acquire" ? redisAdmissionScripts.acquire
      : name === "admission.renew" ? redisAdmissionScripts.renew
        : name === "admission.release" ? redisAdmissionScripts.release
          : name === "admission.sweep" ? redisAdmissionScripts.sweep
            : name === "admission.reconnect" ? redisAdmissionScripts.reconnect
              : undefined;
    if (!script) return Promise.reject(new Error(`Unknown Redis admission script: ${name}`));
    return this.client.withCommandOptions({ timeout: this.input.commandTimeoutMs }).eval(script, {
      keys: [...keys],
      arguments: [...args],
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const wasStarting = this.lifecycle === "starting";
    this.lifecycle = "closed";
    this.cleanupStartFence();
    if (wasStarting) this.startReject?.(abortError());
    this.startReject = undefined;
    this.listeners.clear();
    this.closePromise = this.closeWithinDeadline();
    return this.closePromise;
  }

  private update(state: Health): void {
    if (this.lifecycle === "closed" || this.lifecycle === "failed") return;
    if (this.state === state) return;
    this.state = state;
    this.input.telemetry?.event(state);
    for (const listener of this.listeners) listener(state);
  }

  private cleanupStartFence(): void {
    if (this.connectTimer !== undefined) {
      (this.input.clock ?? systemClock).clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    this.removeStartAbort?.();
    this.removeStartAbort = undefined;
  }

  private destroyOnce(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.input.telemetry?.event("degraded");
    try {
      this.client.destroy();
    } catch {
      // The lifecycle is already fenced; destruction is best effort.
    }
  }

  private closeWithinDeadline(): Promise<void> {
    const clock = this.input.clock ?? systemClock;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (destroy: boolean): void => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(timer);
        if (destroy) this.destroyOnce();
        resolve();
      };
      const timer = clock.setTimeout(() => finish(true), this.input.connectTimeoutMs);
      let closing: Promise<void>;
      try {
        closing = this.client.close();
      } catch {
        finish(true);
        return;
      }
      void closing.then(
        () => finish(false),
        () => finish(true),
      );
    });
  }
}
