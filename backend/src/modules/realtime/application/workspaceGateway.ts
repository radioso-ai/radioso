import type { WorkspaceInvalidationKind } from "@radioso/workspace-invalidation-contract";

import type {
  WorkspaceInterestContinuity,
  WorkspaceInterestContinuitySource,
  WorkspaceInterestTransport,
  WorkspaceInvalidationListener,
  WorkspaceInterestLifecycleState,
} from "../domain/contracts.js";
import {
  systemMonotonicClock,
  type MonotonicClock,
  WorkspaceReleaseDeadlineScheduler,
} from "./workspaceReleaseDeadlineScheduler.js";
import { asError } from "../../../shared/errors/asError.js";

export type WorkspaceGatewayCloseReason = "superseded" | "shutdown" | "transport_lost";

/** Provider-neutral health for the runtime readiness gate. */
export type WorkspaceGatewayHealth = { state: "degraded" | "restored" };
export type WorkspaceGatewayHealthListener = (health: WorkspaceGatewayHealth) => void;

/** Presenter-owned connection/mailbox port; the gateway never writes HTTP. */
export interface WorkspaceGatewayConnection {
  connectionId: string;
  workspaceId: string;
  enqueueInvalidation(kinds: readonly WorkspaceInvalidationKind[]): void;
  enqueueResync(): void;
  requestClose(reason: WorkspaceGatewayCloseReason): void;
}

export interface WorkspaceGatewayTelemetry {
  event(outcome: "subscribed" | "released" | "resync"): void;
  state(state: { interests: number; sessions: number; waiters: number }): void;
}

type Attachment = {
  connection: WorkspaceGatewayConnection;
  ready: boolean;
  token: symbol;
  /** A loss only resyncs connections which were already attached at that point. */
  resyncAfterGeneration: number | undefined;
};

type ReadyWaiter = {
  connectionId: string;
  reject(error: unknown): void;
  resolve(generation: number): void;
  token: symbol;
};

type Interest = {
  command: Promise<void>;
  failure: unknown;
  generation: number;
  listener: WorkspaceInvalidationListener;
  readyWaiters: Map<symbol, ReadyWaiter>;
  releaseDeadline: number | undefined;
  transportLossDeadline: { dueAtMs: number; generation: number } | undefined;
  sessions: Map<string, Attachment>;
  state: WorkspaceInterestLifecycleState;
  subscribed: boolean;
  subscribing: boolean;
  workspaceId: string;
};

export type WorkspaceGatewayAttachment = { generation: number; release(): Promise<void> };

export type WorkspaceGatewayInput = {
  clock?: MonotonicClock;
  continuity: WorkspaceInterestContinuitySource;
  maxWorkspaces: number;
  releaseGraceMs?: number;
  telemetry?: WorkspaceGatewayTelemetry;
  /** Bounded grace before connections which missed broker continuity are closed. */
  transportLossGraceMs?: number;
  transport: WorkspaceInterestTransport;
};

const abortError = () => Object.assign(new Error("Workspace gateway attachment aborted"), { name: "AbortError" });

/**
 * The gateway is the local authority for workspace interest and mailbox fan-out.
 * It deliberately knows neither HTTP writers nor transport/provider details.
 */
export class WorkspaceGateway {
  private readonly clock: MonotonicClock;
  private readonly interests = new Map<string, Interest>();
  private readonly releaseGraceMs: number;
  private readonly removeContinuityListener: () => void;
  private readonly releaseScheduler: WorkspaceReleaseDeadlineScheduler<Interest>;
  private readonly transportLossGraceMs: number;
  private readonly transportLossScheduler: WorkspaceReleaseDeadlineScheduler<Interest>;
  private readonly healthListeners = new Set<WorkspaceGatewayHealthListener>();
  private sessionCount = 0;
  private waiterCount = 0;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private continuityLost = false;
  private continuityGeneration = -1;
  private lossGeneration: number | undefined;

  constructor(private readonly input: WorkspaceGatewayInput) {
    this.clock = input.clock ?? systemMonotonicClock;
    this.releaseGraceMs = Math.max(0, input.releaseGraceMs ?? 0);
    this.transportLossGraceMs = Math.max(0, input.transportLossGraceMs ?? 20_000);
    this.releaseScheduler = new WorkspaceReleaseDeadlineScheduler(this.clock, (interest) => this.onReleaseDeadline(interest));
    this.transportLossScheduler = new WorkspaceReleaseDeadlineScheduler(this.clock, (interest) => this.onTransportLossDeadline(interest));
    this.removeContinuityListener = input.continuity.onContinuity((event) => this.onContinuity(event));
  }

  onHealth(listener: WorkspaceGatewayHealthListener): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  async attach(connection: WorkspaceGatewayConnection, options: { signal?: AbortSignal } = {}): Promise<WorkspaceGatewayAttachment> {
    if (this.shuttingDown) throw new Error("Workspace gateway shutdown");
    if (options.signal?.aborted) throw abortError();

    const workspaceId = connection.workspaceId;
    let interest = this.interests.get(workspaceId);
    if (!interest) {
      if (this.interests.size >= this.input.maxWorkspaces) throw new Error("Workspace gateway workspace interest capacity exceeded");
      interest = this.createInterest(workspaceId);
      this.interests.set(workspaceId, interest);
      this.recordState();
    }

    this.cancelRelease(interest);
    const token = Symbol(connection.connectionId);
    const superseded = interest.sessions.get(connection.connectionId);
    if (superseded) {
      const waiting = interest.readyWaiters.get(superseded.token);
      if (waiting?.token === superseded.token) {
        interest.readyWaiters.delete(superseded.token);
        this.waiterCount -= 1;
        waiting.reject(new Error("Workspace gateway attachment was superseded"));
      }
      // Install the replacement token before calling out: presenter cleanup may
      // synchronously release the old handle, which must be an ABA-safe no-op.
      interest.sessions.set(connection.connectionId, { connection, ready: false, token, resyncAfterGeneration: undefined });
      this.recordState();
      superseded.connection.requestClose("superseded");
    } else {
      interest.sessions.set(connection.connectionId, { connection, ready: false, token, resyncAfterGeneration: undefined });
      this.sessionCount += 1;
      this.recordState();
    }

    try {
      await this.withAbort(this.enqueue(interest), options.signal);
      const generation = await this.withAbort(this.awaitReady(interest, connection.connectionId, token), options.signal);
      if (this.shuttingDown) throw new Error("Workspace gateway shutdown");
      let releasePromise: Promise<void> | undefined;
      return {
        generation,
        release: () => {
          releasePromise ??= this.release(workspaceId, connection.connectionId, token);
          return releasePromise;
        },
      };
    } catch (error) {
      // An attach which fails or aborts cannot retain local interest. The queued
      // release fences a later connection with the same connection id by token.
      void this.release(workspaceId, connection.connectionId, token, error).catch(() => undefined);
      throw error;
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.removeContinuityListener();
    this.releaseScheduler.clear();
    this.transportLossScheduler.clear();

    const cleanup: Promise<void>[] = [];
    for (const interest of this.interests.values()) {
      interest.releaseDeadline = undefined;
      for (const attachment of interest.sessions.values()) attachment.connection.requestClose("shutdown");
      this.sessionCount -= interest.sessions.size;
      interest.sessions.clear();
      this.rejectReadyWaiters(interest, new Error("Workspace gateway shutdown"));
      cleanup.push(this.enqueue(interest).catch(() => undefined));
    }
    this.recordState();
    this.shutdownPromise = Promise.all(cleanup).then(() => undefined);
    return this.shutdownPromise;
  }

  private createInterest(workspaceId: string): Interest {
    const interest: Interest = {
      command: Promise.resolve(),
      failure: undefined,
      generation: 0,
      listener: (kinds) => this.deliver(workspaceId, kinds),
      readyWaiters: new Map(),
      releaseDeadline: undefined,
      transportLossDeadline: undefined,
      sessions: new Map(),
      state: "subscribing",
      subscribed: false,
      subscribing: false,
      workspaceId,
    };
    return interest;
  }

  private enqueue(interest: Interest): Promise<void> {
    const operation = interest.command.then(
      () => this.reconcile(interest),
      () => this.reconcile(interest),
    );
    interest.command = operation;
    return operation;
  }

  private dropInterest(interest: Interest): void {
    if (this.interests.get(interest.workspaceId) !== interest) return;
    this.cancelTransportLossDeadline(interest);
    this.interests.delete(interest.workspaceId);
    this.recordState();
  }

  private recordState(): void {
    this.input.telemetry?.state({ interests: this.interests.size, sessions: this.sessionCount, waiters: this.waiterCount });
  }

  private async reconcile(interest: Interest): Promise<void> {
    if (this.interests.get(interest.workspaceId) !== interest) {
      if (interest.failure) throw asError(interest.failure);
      return;
    }

    const desired = interest.sessions.size > 0;
    if (desired && !interest.subscribed) {
      if (this.continuityLost) {
        interest.state = "reconnecting";
        return;
      }
      interest.state = "subscribing";
      interest.subscribing = true;
      try {
        const subscription = await this.input.transport.subscribe(interest.workspaceId, interest.listener);
        interest.subscribed = true;
        interest.generation = this.continuityGeneration >= 0 ? this.continuityGeneration : subscription.generation;
        this.input.telemetry?.event("subscribed");
      } catch (error) {
        interest.failure = error;
        this.sessionCount -= interest.sessions.size;
        interest.sessions.clear();
        this.dropInterest(interest);
        this.rejectReadyWaiters(interest, error);
        throw error;
      } finally {
        interest.subscribing = false;
      }
    }

    if (interest.sessions.size === 0 && interest.releaseDeadline === undefined && interest.subscribed) {
      interest.state = "releasing";
      try {
        await this.input.transport.unsubscribe(interest.workspaceId, interest.listener);
      } catch (error) {
        // The transport contract detaches this exact callback before acknowledging
        // (or rejecting), so a following add must create fresh remote interest.
        interest.subscribed = false;
        if (interest.sessions.size === 0) this.dropInterest(interest);
        throw error;
      }
      interest.subscribed = false;
      this.input.telemetry?.event("released");
    }

    if (interest.sessions.size === 0 && !interest.subscribed && interest.releaseDeadline === undefined) {
      this.dropInterest(interest);
      return;
    }

    if (interest.subscribed && !this.continuityLost && interest.sessions.size > 0) {
      interest.state = "active";
      this.resolveReadyWaiters(interest);
    }
  }

  private awaitReady(interest: Interest, connectionId: string, token: symbol): Promise<number> {
    const attachment = interest.sessions.get(connectionId);
    if (!attachment || attachment.token !== token) return Promise.reject(new Error("Workspace gateway attachment was superseded"));
    if (this.shuttingDown) return Promise.reject(new Error("Workspace gateway shutdown"));
    if (interest.failure) return Promise.reject(asError(interest.failure));
    if (interest.subscribed && !this.continuityLost && interest.state === "active") {
      attachment.ready = true;
      return Promise.resolve(interest.generation);
    }
    return new Promise<number>((resolve, reject) => {
      interest.readyWaiters.set(token, { connectionId, token, resolve, reject });
      this.waiterCount += 1;
      this.recordState();
    });
  }

  private resolveReadyWaiters(interest: Interest): void {
    const count = interest.readyWaiters.size;
    for (const waiter of interest.readyWaiters.values()) {
      const attachment = interest.sessions.get(waiter.connectionId);
      if (attachment?.token === waiter.token) {
        attachment.ready = true;
        waiter.resolve(interest.generation);
      }
      else waiter.reject(new Error("Workspace gateway attachment was superseded"));
    }
    interest.readyWaiters.clear();
    this.waiterCount -= count;
    if (count > 0) this.recordState();
  }

  private rejectReadyWaiters(interest: Interest, error: unknown): void {
    const count = interest.readyWaiters.size;
    for (const waiter of interest.readyWaiters.values()) waiter.reject(error);
    interest.readyWaiters.clear();
    this.waiterCount -= count;
    if (count > 0) this.recordState();
  }

  private release(workspaceId: string, connectionId: string, token: symbol, reason?: unknown): Promise<void> {
    const interest = this.interests.get(workspaceId);
    if (!interest) return Promise.resolve();
    const attachment = interest.sessions.get(connectionId);
    if (!attachment || attachment.token !== token) return Promise.resolve();
    const waiter = interest.readyWaiters.get(token);
    if (waiter) {
      interest.readyWaiters.delete(token);
      this.waiterCount -= 1;
      waiter.reject(reason ?? new Error("Workspace gateway attachment released"));
    }
    interest.sessions.delete(connectionId);
    this.sessionCount -= 1;
    this.recordState();
    if (interest.sessions.size > 0) return Promise.resolve();

    this.cancelTransportLossDeadline(interest);

    if (this.releaseGraceMs > 0 && !this.shuttingDown) {
      this.scheduleRelease(interest);
      return Promise.resolve();
    }
    interest.releaseDeadline = undefined;
    return this.enqueue(interest);
  }

  private deliver(workspaceId: string, kinds: readonly WorkspaceInvalidationKind[]): void {
    const interest = this.interests.get(workspaceId);
    if (!interest || !interest.subscribed) return;
    for (const attachment of interest.sessions.values()) attachment.connection.enqueueInvalidation(kinds);
  }

  private onContinuity(event: WorkspaceInterestContinuity): void {
    if (this.shuttingDown) return;
    if (event.state === "lost") {
      if ((this.continuityLost && event.generation <= (this.lossGeneration ?? -1)) || (!this.continuityLost && event.generation <= this.continuityGeneration)) return;
      this.continuityLost = true;
      this.lossGeneration = event.generation;
      this.continuityGeneration = event.generation;
      this.emitHealth({ state: "degraded" });
      for (const interest of this.interests.values()) {
        if (interest.sessions.size === 0) continue;
        interest.state = "reconnecting";
        let affected = false;
        for (const attachment of interest.sessions.values()) {
          if (attachment.ready) {
            attachment.resyncAfterGeneration = event.generation;
            affected = true;
          }
        }
        if (affected) this.scheduleTransportLossDeadline(interest, event.generation);
      }
      return;
    }

    if (!this.continuityLost || event.generation !== this.lossGeneration) return;
    this.continuityLost = false;
    this.continuityGeneration = event.generation;
    this.lossGeneration = undefined;
    this.emitHealth({ state: "restored" });
    let resynced = false;
    for (const interest of this.interests.values()) {
      if (interest.sessions.size === 0) continue;
      // The subscriber owns broker reattachment. Cancel the local failure fence
      // before exposing any resync to presenters; this path never subscribes again.
      this.cancelTransportLossDeadline(interest, event.generation);
      interest.generation = event.generation;
      if (!interest.subscribed) {
        if (interest.subscribing) continue;
        // This local interest was never accepted by the subscriber before the
        // loss, so it is not among the subscriber's desired interests to
        // restore. Do not create a second subscribe path from a restore event.
        const error = new Error("Workspace gateway subscription was unavailable during transport recovery");
        interest.failure = error;
        this.rejectReadyWaiters(interest, error);
        continue;
      }
      interest.state = "active";
      for (const attachment of interest.sessions.values()) {
        if (attachment.resyncAfterGeneration === event.generation) {
          attachment.resyncAfterGeneration = undefined;
          attachment.connection.enqueueResync();
          resynced = true;
        }
      }
      this.resolveReadyWaiters(interest);
    }
    if (resynced) this.input.telemetry?.event("resync");
  }

  private scheduleRelease(interest: Interest): void {
    const deadline = this.clock.now() + this.releaseGraceMs;
    interest.releaseDeadline = deadline;
    this.releaseScheduler.schedule(interest.workspaceId, interest, deadline);
  }

  private cancelRelease(interest: Interest): void {
    if (interest.releaseDeadline === undefined) return;
    interest.releaseDeadline = undefined;
    this.releaseScheduler.cancel(interest.workspaceId);
  }

  private onReleaseDeadline(interest: Interest): void {
    if (this.interests.get(interest.workspaceId) !== interest || interest.sessions.size > 0) return;
    interest.releaseDeadline = undefined;
    void this.enqueue(interest).catch(() => undefined);
  }

  private scheduleTransportLossDeadline(interest: Interest, generation: number): void {
    const dueAtMs = this.clock.now() + this.transportLossGraceMs;
    interest.transportLossDeadline = { dueAtMs, generation };
    this.transportLossScheduler.schedule(interest.workspaceId, interest, dueAtMs);
  }

  private cancelTransportLossDeadline(interest: Interest, generation?: number): void {
    if (!interest.transportLossDeadline) return;
    if (generation !== undefined && interest.transportLossDeadline.generation !== generation) return;
    interest.transportLossDeadline = undefined;
    this.transportLossScheduler.cancel(interest.workspaceId);
  }

  private onTransportLossDeadline(interest: Interest): void {
    const deadline = interest.transportLossDeadline;
    interest.transportLossDeadline = undefined;
    if (!deadline || this.interests.get(interest.workspaceId) !== interest || !this.continuityLost || deadline.generation !== this.lossGeneration) return;

    let released = false;
    for (const [connectionId, attachment] of [...interest.sessions]) {
      if (attachment.resyncAfterGeneration !== deadline.generation) continue;
      // Fence removal before calling out: a synchronous presenter release is an
      // ABA-safe no-op and cannot retain the stale workspace interest.
      attachment.resyncAfterGeneration = undefined;
      interest.sessions.delete(connectionId);
      this.sessionCount -= 1;
      attachment.connection.requestClose("transport_lost");
      released = true;
    }
    if (!released) return;
    this.recordState();
    if (interest.sessions.size === 0) void this.enqueue(interest).catch(() => undefined);
  }

  private emitHealth(health: WorkspaceGatewayHealth): void {
    for (const listener of this.healthListeners) listener(health);
  }

  private async withAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return operation;
    if (signal.aborted) throw abortError();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }
}
