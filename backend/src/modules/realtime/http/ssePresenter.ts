import { randomUUID } from "node:crypto";

import type { WorkspaceInvalidationKind } from "@radioso/workspace-invalidation-contract";

import type { WorkspaceGatewayAttachment, WorkspaceGatewayConnection } from "../application/workspaceGateway.js";
import { RealtimeSession } from "../domain/realtimeSession.js";
import type { AdmissionLeaseRisk, RealtimeAdmissionController, RealtimeAdmissionLease } from "../domain/contracts.js";

type ResponseEvent = "close" | "drain" | "error" | "finish";

/** The tiny writer port deliberately avoids binding the presenter to Express. */
export interface SseResponse {
  commitSse(): void;
  write(frame: Uint8Array): boolean;
  readonly writableLength: number;
  end(): void;
  destroy(error?: unknown): void;
  on(event: ResponseEvent, listener: () => void): void;
  off(event: ResponseEvent, listener: () => void): void;
}

export type SsePresenterClock = {
  monotonicNow(): number;
  wallNow(): number;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
};

export type SsePresenterLimits = {
  streamAgeMs: number;
  gatewayTimeoutMs: number;
  edgeTimeoutMs: number;
  heartbeatMs: number;
  blockedDurationMs: number;
  blockedWritableBytes: number;
  frameBytes: number;
  authTimeoutMs: number;
  subscribeTimeoutMs: number;
};

export interface SseStreamTelemetry {
  gaugeDelta(name: "active" | "blocked", delta: 1 | -1): void;
  counter(name: "opened" | "ready" | "slow" | "expired" | "closed"): void;
  histogram(name: "time_to_ready" | "lifetime" | "blocked_duration" | "backlog", value: number): void;
}

export type SsePresenterRegistration = {
  promise: Promise<void>;
  abortPreflight(): void;
  forceDestroy(): void;
};

export type SsePresenterReservation = {
  track(registration: SsePresenterRegistration): Promise<void>;
  release(): void;
};

export type RealtimeStreamIdentity = {
  accountId: string;
  workspaceId: string;
  principalId: string;
  sessionExpiresAt: Date;
};

export type SsePresenterInput = {
  authorize(signal: AbortSignal): Promise<RealtimeStreamIdentity>;
  admission: Pick<RealtimeAdmissionController, "admit" | "checkReconnect">;
  gateway: { attach(connection: WorkspaceGatewayConnection, options: { signal: AbortSignal }): Promise<WorkspaceGatewayAttachment> };
  response: SseResponse;
  signal?: AbortSignal;
  shutdown?: AbortSignal;
  clock: SsePresenterClock;
  limits: SsePresenterLimits;
  telemetry?: SseStreamTelemetry;
};

type CloseMode = "none" | "end" | "destroy";
type SsePrecommitExpiryReason = "session_expiring" | "runtime_expired";

export class SsePrecommitExpiredError extends Error {
  constructor(readonly reason: SsePrecommitExpiryReason) {
    super(reason === "session_expiring"
      ? "Realtime session expires too soon to open a stream"
      : "Realtime stream preflight exceeded its runtime deadline");
    this.name = "SsePrecommitExpiredError";
  }
}

const SESSION_TIMEOUT_SAFETY_MS = 30_000;
const abortError = () => Object.assign(new Error("Realtime stream operation aborted"), { name: "AbortError" });
const encoder = new TextEncoder();

/**
 * Provider-neutral stream lifecycle and bounded SSE writer. HTTP adapters supply
 * the small response port; the gateway supplies a mailbox-only connection port.
 */
export class SsePresenter {
  private readonly startedAt: number;
  private readonly requestAbort = new AbortController();
  private readonly finished: Promise<void>;
  private finish!: () => void;
  private timer: number | undefined;
  private connection: WorkspaceGatewayConnection | undefined;
  private session: RealtimeSession | undefined;
  private lease: RealtimeAdmissionLease | undefined;
  private attachment: WorkspaceGatewayAttachment | undefined;
  private leaseReleased = false;
  private attachmentReleased = false;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private committed = false;
  private active = false;
  private blocked = false;
  private blockedAt: number | undefined;
  private nextHeartbeatAt: number | undefined;
  private riskCloseAt: number | undefined;
  private effectiveExpiryAt: number | undefined;
  private effectiveExpiryReason: "session" | "runtime" | undefined;
  private pumping = false;
  private readyPending = false;
  private readonly listeners: Array<[ResponseEvent, () => void]> = [];
  private readonly signalDisposers: Array<() => void> = [];
  private readonly lateCleanup: Promise<void>[] = [];

  constructor(private readonly input: SsePresenterInput) {
    this.startedAt = input.clock.monotonicNow();
    this.finished = new Promise<void>((resolve) => { this.finish = resolve; });
  }

  async start(): Promise<void> {
    if (!this.installCloseFence()) {
      await this.closePromise;
      return;
    }
    this.input.telemetry?.counter("opened");
    try {
      const identity = await this.awaitDependency((signal) => this.input.authorize(signal), this.input.limits.authTimeoutMs);
      if (!identity || this.closed) return;

      this.effectiveExpiryAt = this.effectiveExpiry(identity.sessionExpiresAt);
      if (this.input.clock.monotonicNow() >= this.effectiveExpiryAt) {
        throw this.precommitExpiredError();
      }

      const admissionIdentity = { accountId: identity.accountId, workspaceId: identity.workspaceId, principalId: identity.principalId };
      await this.awaitDependency((signal) => this.input.admission.checkReconnect(admissionIdentity));
      if (this.closed) return;
      if (this.input.clock.monotonicNow() >= this.effectiveExpiryAt) {
        throw this.precommitExpiredError();
      }

      const lease = await this.awaitDependency(
        (signal) => this.input.admission.admit(admissionIdentity),
        undefined,
        (lateLease) => this.releaseLease(lateLease),
      );
      if (!lease) {
        await this.settleLateCleanup();
        return;
      }
      if (this.closed) {
        await this.releaseLease(lease);
        return;
      }
      this.lease = lease;
      this.observeLeaseRisk(lease.risk);
      if (this.closed) return;

      if (this.input.clock.monotonicNow() >= this.effectiveExpiryAt) {
        throw this.precommitExpiredError();
      }

      const connection = this.createConnection(identity.workspaceId);
      this.connection = connection;
      const attachment = await this.awaitDependency(
        (signal) => this.input.gateway.attach(connection, { signal }),
        this.input.limits.subscribeTimeoutMs,
        (lateAttachment) => this.releaseAttachment(lateAttachment),
      );
      if (!attachment) {
        await this.settleLateCleanup();
        return;
      }
      if (this.closed) {
        await this.releaseAttachment(attachment);
        return;
      }
      if (this.input.clock.monotonicNow() >= this.effectiveExpiryAt) {
        await this.releaseAttachment(attachment);
        throw this.precommitExpiredError();
      }
      this.attachment = attachment;

      this.input.response.commitSse();
      this.committed = true;
      this.active = true;
      this.readyPending = true;
      this.nextHeartbeatAt = this.input.clock.monotonicNow() + this.input.limits.heartbeatMs;
      this.input.telemetry?.gaugeDelta("active", 1);
      this.input.telemetry?.counter("ready");
      this.input.telemetry?.histogram("time_to_ready", Math.max(0, this.input.clock.monotonicNow() - this.startedAt));
      this.pump();
      this.scheduleDeadline();
      await this.finished;
      await this.closePromise;
    } catch (error) {
      await this.close("none");
      throw error;
    }
  }

  private installCloseFence(): boolean {
    this.listen("close", () => { void this.close("none"); });
    this.listen("error", () => { void this.close("none"); });
    this.listen("finish", () => { void this.close("none"); });
    if (this.input.signal && !this.listenAbort(this.input.signal, "none")) return false;
    if (this.input.shutdown && !this.listenAbort(this.input.shutdown, "end")) return false;
    return !this.closed;
  }

  private listen(event: ResponseEvent, listener: () => void): void {
    this.listeners.push([event, listener]);
    this.input.response.on(event, listener);
  }

  private listenAbort(signal: AbortSignal, mode: CloseMode): boolean {
    const listener = () => { void this.close(mode); };
    if (signal.aborted) {
      listener();
      return false;
    }
    signal.addEventListener("abort", listener, { once: true });
    this.signalDisposers.push(() => signal.removeEventListener("abort", listener));
    return true;
  }

  private createConnection(workspaceId: string): WorkspaceGatewayConnection {
    const session = new RealtimeSession({ connectionId: randomUUID(), workspaceId });
    this.session = session;
    return {
      connectionId: session.identity.connectionId,
      workspaceId,
      enqueueInvalidation: (kinds) => {
        session.mergeInvalidation(kinds);
        this.pump();
      },
      enqueueResync: () => {
        session.requireResync();
        this.pump();
      },
      requestClose: () => { void this.close("end"); },
    };
  }

  private effectiveExpiry(sessionExpiresAt: Date): number {
    const now = this.input.clock.monotonicNow();
    const sessionRemaining = sessionExpiresAt.getTime() - this.input.clock.wallNow() - SESSION_TIMEOUT_SAFETY_MS;
    const deadlines = [
      { at: now + sessionRemaining, reason: "session" as const },
      { at: this.startedAt + this.input.limits.streamAgeMs, reason: "runtime" as const },
      { at: this.startedAt + this.input.limits.gatewayTimeoutMs - SESSION_TIMEOUT_SAFETY_MS, reason: "runtime" as const },
      { at: this.startedAt + this.input.limits.edgeTimeoutMs - SESSION_TIMEOUT_SAFETY_MS, reason: "runtime" as const },
    ];
    const selected = deadlines.reduce((earliest, candidate) => candidate.at < earliest.at ? candidate : earliest);
    this.effectiveExpiryReason = selected.reason;
    return selected.at;
  }

  private precommitExpiredError(): SsePrecommitExpiredError {
    return new SsePrecommitExpiredError(this.effectiveExpiryReason === "session" ? "session_expiring" : "runtime_expired");
  }

  private observeLeaseRisk(risk: Promise<AdmissionLeaseRisk>): void {
    void risk.then((value) => {
      if (this.closed) return;
      // Before the response becomes visible, a lease that cannot be sustained
      // is never a valid admission. Once visible, honour the controller's
      // bounded monotonic grace deadline instead.
      if (!this.committed) {
        void this.close("none");
        return;
      }
      this.riskCloseAt = value.closeAtMs;
      if (this.input.clock.monotonicNow() >= value.closeAtMs) void this.close("end");
      else this.scheduleDeadline();
    }).catch(() => {
      if (!this.closed) void this.close("end");
    });
  }

  private pump(): void {
    if (this.closed || !this.committed || this.blocked || this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && !this.blocked) {
        let frame: Uint8Array | undefined;
        let pending: ReturnType<RealtimeSession["takePending"]>;
        if (this.readyPending) {
          this.readyPending = false;
          frame = this.frame("ready", { protocolVersion: 1 });
        } else {
          pending = this.session?.takePending();
          if (pending?.type === "resync") frame = this.frame("resync", { protocolVersion: 1 });
          else if (pending?.type === "invalidate") frame = this.frame("invalidate", { protocolVersion: 1, changeKinds: pending.changeKinds });
          else if (this.nextHeartbeatAt !== undefined && this.input.clock.monotonicNow() >= this.nextHeartbeatAt) {
            this.nextHeartbeatAt = this.input.clock.monotonicNow() + this.input.limits.heartbeatMs;
            frame = encoder.encode(": heartbeat\n\n");
          }
        }
        if (!frame) break;
        if (frame.byteLength > this.input.limits.frameBytes) {
          if (pending) this.session?.restorePending(pending);
          void this.close("destroy", new Error("Realtime SSE frame exceeds configured cap"));
          break;
        }
        try {
          const writable = this.input.response.write(frame);
          this.input.telemetry?.histogram("backlog", Math.max(0, this.input.response.writableLength));
          // A completed write is accepted even when it applies backpressure. A
          // reentrant enqueue lands in a new mailbox slot, so never restore the
          // marker we have just handed to the response writer.
          if (pending) this.nextHeartbeatAt = this.input.clock.monotonicNow() + this.input.limits.heartbeatMs;
          if (this.input.response.writableLength >= this.input.limits.blockedWritableBytes) {
            void this.close("destroy", new Error("Realtime SSE writer backlog exceeded"));
            break;
          }
          if (!writable) {
            this.enterBlocked();
            break;
          }
        } catch (error) {
          if (pending) this.session?.restorePending(pending);
          void this.close("destroy", error);
          break;
        }
      }
    } finally {
      this.pumping = false;
      this.scheduleDeadline();
    }
  }

  private frame(event: "ready" | "invalidate" | "resync", data: object): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private enterBlocked(): void {
    if (this.closed || this.blocked) return;
    if (this.input.response.writableLength >= this.input.limits.blockedWritableBytes) {
      void this.close("destroy", new Error("Realtime SSE writer backlog exceeded"));
      return;
    }
    this.blocked = true;
    this.blockedAt = this.input.clock.monotonicNow();
    this.input.telemetry?.gaugeDelta("blocked", 1);
    const onDrain = () => {
      if (this.closed) return;
      this.leaveBlocked();
      this.pump();
    };
    this.listen("drain", onDrain);
    this.scheduleDeadline();
  }

  private leaveBlocked(): void {
    if (!this.blocked) return;
    const started = this.blockedAt;
    this.blocked = false;
    this.blockedAt = undefined;
    this.input.telemetry?.gaugeDelta("blocked", -1);
    if (started !== undefined) this.input.telemetry?.histogram("blocked_duration", Math.max(0, this.input.clock.monotonicNow() - started));
    for (let index = this.listeners.length - 1; index >= 0; index -= 1) {
      const [event, listener] = this.listeners[index]!;
      if (event !== "drain") continue;
      this.input.response.off(event, listener);
      this.listeners.splice(index, 1);
    }
  }

  private scheduleDeadline(): void {
    if (this.closed) return;
    const now = this.input.clock.monotonicNow();
    const deadlines = [
      this.effectiveExpiryAt,
      this.riskCloseAt,
      this.blockedAt === undefined ? undefined : this.blockedAt + this.input.limits.blockedDurationMs,
      this.blocked ? undefined : this.nextHeartbeatAt,
    ].filter((value): value is number => value !== undefined);
    const deadline = Math.min(...deadlines);
    if (!Number.isFinite(deadline)) return;
    if (this.timer !== undefined) this.input.clock.clearTimeout(this.timer);
    this.timer = this.input.clock.setTimeout(() => {
      this.timer = undefined;
      this.onDeadline();
    }, Math.max(0, deadline - now));
  }

  private onDeadline(): void {
    if (this.closed) return;
    const now = this.input.clock.monotonicNow();
    if (this.effectiveExpiryAt !== undefined && now >= this.effectiveExpiryAt) {
      this.input.telemetry?.counter("expired");
      void this.close("end");
      return;
    }
    if (this.riskCloseAt !== undefined && now >= this.riskCloseAt) {
      void this.close("end");
      return;
    }
    if (this.blockedAt !== undefined && (now >= this.blockedAt + this.input.limits.blockedDurationMs || this.input.response.writableLength >= this.input.limits.blockedWritableBytes)) {
      this.input.telemetry?.counter("slow");
      void this.close("destroy", new Error("Realtime SSE writer remained blocked"));
      return;
    }
    this.pump();
    this.scheduleDeadline();
  }

  private async close(mode: CloseMode, error?: unknown): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.requestAbort.abort();
    if (this.timer !== undefined) this.input.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.session?.close();
    for (const [event, listener] of this.listeners) this.input.response.off(event, listener);
    this.listeners.length = 0;
    for (const dispose of this.signalDisposers.splice(0)) dispose();
    if (this.blocked) this.leaveBlocked();
    if (this.active) {
      this.active = false;
      this.input.telemetry?.gaugeDelta("active", -1);
    }
    if (this.committed && mode === "end") this.input.response.end();
    if (this.committed && mode === "destroy") this.input.response.destroy(error);
    this.input.telemetry?.counter("closed");
    this.input.telemetry?.histogram("lifetime", Math.max(0, this.input.clock.monotonicNow() - this.startedAt));
    this.finish();
    this.closePromise = Promise.allSettled([this.releaseAttachment(), this.releaseLease()]).then(() => undefined);
    return this.closePromise;
  }

  private releaseAttachment(attachment = this.attachment): Promise<void> {
    if (!attachment || this.attachmentReleased) return Promise.resolve();
    this.attachmentReleased = true;
    return attachment.release();
  }

  private releaseLease(lease = this.lease): Promise<void> {
    if (!lease || this.leaseReleased) return Promise.resolve();
    this.leaseReleased = true;
    return lease.release();
  }

  private async awaitDependency<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
    releaseLate?: (value: T) => Promise<void>,
  ): Promise<T | undefined> {
    if (this.closed) return undefined;
    const controller = new AbortController();
    let timeout: number | undefined;
    let removeAbort: () => void = () => undefined;
    const operation = Promise.resolve().then(() => run(controller.signal));
    const late = releaseLate
      ? operation.then((value) => this.closed ? releaseLate(value) : undefined).catch(() => undefined)
      : undefined;
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const onClose = () => {
          controller.abort();
          if (late) this.lateCleanup.push(late);
          resolve(undefined);
        };
        this.requestAbort.signal.addEventListener("abort", onClose, { once: true });
        removeAbort = () => this.requestAbort.signal.removeEventListener("abort", onClose);
        if (timeoutMs !== undefined) {
          timeout = this.input.clock.setTimeout(() => {
            controller.abort();
            reject(abortError());
          }, timeoutMs);
        }
        operation.then(
          (value) => {
            if (this.closed) {
              resolve(undefined);
              return;
            }
            resolve(value);
          },
          reject,
        );
      });
    } finally {
      if (timeout !== undefined) this.input.clock.clearTimeout(timeout);
      removeAbort();
    }
  }

  private async settleLateCleanup(): Promise<void> {
    if (this.lateCleanup.length === 0) return;
    await Promise.allSettled(this.lateCleanup.splice(0));
  }
}
