import { describe, expect, it, vi } from "vitest";

import type { WorkspaceGatewayAttachment, WorkspaceGatewayCloseReason, WorkspaceGatewayConnection } from "../../../src/modules/realtime/application/workspaceGateway.js";
import type { AdmissionLeaseRisk, RealtimeAdmissionLease } from "../../../src/modules/realtime/domain/contracts.js";
import { INVALIDATION_KINDS } from "@radioso/workspace-invalidation-contract";
import { SsePresenter } from "../../../src/modules/realtime/http/ssePresenter.js";

const workspaceId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
const accountId = "a5f6d0d3-98e8-4d1e-8c76-2b4f1d1de9a1";
const principalId = "user-42";
const sessionExpiresAt = new Date("2026-08-25T00:30:00.000Z");
const invalidation = ["crawl.progress"] as const;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

type CountedAbortSignal = {
  controller: AbortController;
  signal: AbortSignal;
  addCount(): number;
  removeCount(): number;
  activeCount(): number;
};

const countedAbortSignal = (): CountedAbortSignal => {
  const controller = new AbortController();
  let adds = 0;
  let removes = 0;
  let active = 0;
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "addEventListener") {
        return (type: "abort", listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          adds += 1;
          active += 1;
          target.addEventListener(type, listener, options);
        };
      }
      if (property === "removeEventListener") {
        return (type: "abort", listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
          removes += 1;
          active = Math.max(0, active - 1);
          target.removeEventListener(type, listener, options);
        };
      }
      return Reflect.get(target, property, target);
    },
  }) as AbortSignal;
  return {
    controller,
    signal,
    addCount: () => adds,
    removeCount: () => removes,
    activeCount: () => active,
  };
};

type ResponseEvent = "drain" | "close" | "error" | "finish";
type PresenterLimits = {
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

type StreamTelemetry = {
  gaugeDelta(name: "active" | "blocked", delta: 1 | -1): void;
  counter(name: "opened" | "ready" | "slow" | "expired" | "closed"): void;
  histogram(name: "time_to_ready" | "lifetime" | "blocked_duration" | "backlog", value: number): void;
};

class TestClock {
  monotonic = 0;
  wall = sessionExpiresAt.getTime() - 15 * 60_000;
  private nextTimer = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private maximumOutstandingTimers = 0;

  monotonicNow = (): number => this.monotonic;
  wallNow = (): number => this.wall;
  setTimeout = (callback: () => void, delay: number): number => {
    const id = this.nextTimer++;
    this.timers.set(id, { at: this.monotonic + Math.max(0, delay), callback });
    this.maximumOutstandingTimers = Math.max(this.maximumOutstandingTimers, this.timers.size);
    return id;
  };
  clearTimeout = (id: number): void => { this.timers.delete(id); };

  advance(ms: number): void {
    this.monotonic += ms;
    this.wall += ms;
    this.flush();
  }

  jumpWall(ms: number): void { this.wall += ms; }
  timerCount(): number { return this.timers.size; }
  maxOutstandingTimers(): number { return this.maximumOutstandingTimers; }

  private flush(): void {
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.monotonic)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

const responseFixture = () => {
  const listeners = new Map<ResponseEvent, Set<() => void>>();
  let writableLength = 0;
  let writesBlocked = false;
  let nextWriteWritableLength = 0;
  let writesInFlight = 0;
  let maxWritesInFlight = 0;
  let maxDrainListeners = 0;
  const response = {
    committed: false,
    writes: [] as Uint8Array[],
    ended: false,
    destroyed: undefined as unknown,
    commitSse: vi.fn(() => { response.committed = true; }),
    write: vi.fn((frame: Uint8Array): boolean => {
      if (response.destroyed !== undefined) throw new Error("write after destroy");
      writesInFlight += 1;
      maxWritesInFlight = Math.max(maxWritesInFlight, writesInFlight);
      response.writes.push(frame);
      writableLength = nextWriteWritableLength;
      writesInFlight -= 1;
      return !writesBlocked;
    }),
    get writableLength() { return writableLength; },
    end: vi.fn(() => { response.ended = true; }),
    destroy: vi.fn((error?: unknown) => { response.destroyed = error ?? new Error("destroyed"); }),
    on: (event: ResponseEvent, listener: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(event, set);
      if (event === "drain") maxDrainListeners = Math.max(maxDrainListeners, set.size);
    },
    off: (event: ResponseEvent, listener: () => void) => listeners.get(event)?.delete(listener),
    emit: (event: ResponseEvent) => { for (const listener of [...(listeners.get(event) ?? [])]) listener(); },
    listenerCount: (event?: ResponseEvent) => event === undefined
      ? [...listeners.values()].reduce((count, set) => count + set.size, 0)
      : listeners.get(event)?.size ?? 0,
    setWritableLength: (value: number) => { writableLength = value; nextWriteWritableLength = value; },
    configureWrite: (options: { blocked: boolean; writableLength: number }) => {
      writesBlocked = options.blocked;
      nextWriteWritableLength = options.writableLength;
      writableLength = options.writableLength;
    },
    blockWrites: (value: boolean) => { writesBlocked = value; },
    maxDrainListeners: () => maxDrainListeners,
    maxWritesInFlight: () => maxWritesInFlight,
  };
  return response;
};

const defaultLimits: PresenterLimits = {
  streamAgeMs: 10 * 60_000,
  gatewayTimeoutMs: 20 * 60_000,
  edgeTimeoutMs: 20 * 60_000,
  heartbeatMs: 20_000,
  blockedDurationMs: 10_000,
  blockedWritableBytes: 256,
  frameBytes: 4 * 1024,
  authTimeoutMs: 2_000,
  subscribeTimeoutMs: 3_000,
};

type FixtureOverrides = {
  limits?: Partial<PresenterLimits>;
  telemetry?: StreamTelemetry;
  requestController?: AbortController;
  requestSignal?: AbortSignal;
  shutdownController?: AbortController;
  shutdownSignal?: AbortSignal;
};

const fixture = (overrides: FixtureOverrides = {}) => {
  const clock = new TestClock();
  const response = responseFixture();
  const attached = deferred<WorkspaceGatewayAttachment>();
  const release = vi.fn(async (): Promise<void> => undefined);
  const leaseRelease = vi.fn(async (): Promise<void> => undefined);
  const leaseRisk = deferred<AdmissionLeaseRisk>();
  const authorize = vi.fn(async (_signal: AbortSignal) => ({ accountId, workspaceId, principalId, sessionExpiresAt }));
  const checkReconnect = vi.fn(async (_identity: { accountId: string; workspaceId: string; principalId: string }): Promise<void> => undefined);
  const admit = vi.fn(async (_identity: { accountId: string; workspaceId: string; principalId: string }): Promise<RealtimeAdmissionLease> => ({ risk: leaseRisk.promise, release: leaseRelease }));
  let connection: WorkspaceGatewayConnection | undefined;
  const attach = vi.fn(async (candidate: WorkspaceGatewayConnection, _options: { signal: AbortSignal }): Promise<WorkspaceGatewayAttachment> => {
    connection = candidate;
    return attached.promise;
  });
  const signal = overrides.requestController ?? new AbortController();
  const shutdown = overrides.shutdownController ?? new AbortController();
  const telemetry = overrides.telemetry;
  const input = {
    authorize,
    admission: { checkReconnect, admit },
    gateway: { attach },
    response,
    signal: overrides.requestSignal ?? signal.signal,
    shutdown: overrides.shutdownSignal ?? shutdown.signal,
    clock: {
      monotonicNow: clock.monotonicNow,
      wallNow: clock.wallNow,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
    limits: { ...defaultLimits, ...overrides.limits },
    telemetry,
  };
  const presenter = new SsePresenter(input);
  return {
    clock, response, attached, release, leaseRelease, leaseRisk, authorize, checkReconnect, admit,
    attach, signal, shutdown, presenter, get connection() { return connection; },
  };
};

const resolveAttachment = (f: ReturnType<typeof fixture>): void => {
  f.attached.resolve({ generation: 1, release: f.release });
};

const frameText = (frame: Uint8Array): string => new TextDecoder().decode(frame);
const waitForCommit = async (response: ReturnType<typeof responseFixture>) => {
  await vi.waitFor(() => expect(response.commitSse).toHaveBeenCalledOnce());
};

describe("SsePresenter RED contract", () => {
  it("authorizes, checks reconnect, admits, and subscribes before atomic commit; ready is first", async () => {
    const f = fixture();
    const auth = deferred<{ accountId: string; workspaceId: string; principalId: string; sessionExpiresAt: Date }>();
    f.authorize.mockReturnValueOnce(auth.promise);
    const opening = f.presenter.start();
    expect(f.checkReconnect).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.attach).not.toHaveBeenCalled();
    auth.resolve({ accountId, workspaceId, principalId, sessionExpiresAt });
    await vi.waitFor(() => expect(f.checkReconnect).toHaveBeenCalledWith({ accountId, workspaceId, principalId }));
    await vi.waitFor(() => expect(f.admit).toHaveBeenCalledWith({ accountId, workspaceId, principalId }));
    expect(f.attach).toHaveBeenCalledOnce();
    expect(f.response.commitSse).not.toHaveBeenCalled();
    resolveAttachment(f);
    await waitForCommit(f.response);
    expect(f.response.commitSse).toHaveBeenCalledWith();
    expect(f.response.commitSse.mock.invocationCallOrder[0]).toBeLessThan(f.response.write.mock.invocationCallOrder[0]!);
    expect(frameText(f.response.writes[0]!)).toBe('event: ready\ndata: {"protocolVersion":1}\n\n');
    expect(f.response.writes).toHaveLength(1);
    f.response.emit("close");
    await opening;
  });

  it("uses only the injected clock and keeps one runtime deadline timer per stream", async () => {
    const f = fixture();
    const timerFailure = new Error("presenter used a global timer");
    const globalSetTimeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => { throw timerFailure; });
    const opening = f.presenter.start();
    for (let turn = 0; turn < 128 && globalSetTimeout.mock.calls.length === 0 && f.admit.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    const globalTimerCalls = globalSetTimeout.mock.calls.length;
    globalSetTimeout.mockRestore();

    if (globalTimerCalls > 0) {
      await expect(opening).rejects.toBe(timerFailure);
    } else {
      await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
      resolveAttachment(f);
      await waitForCommit(f.response);
      expect(f.clock.maxOutstandingTimers()).toBeLessThanOrEqual(1);
      f.response.emit("close");
      await opening;
    }
    expect(globalTimerCalls).toBe(0);
    expect(f.clock.timerCount()).toBe(0);
  });

  it("does not call later dependencies, commit, or write after an auth/preflight abort", async () => {
    const f = fixture();
    const auth = deferred<never>();
    f.authorize.mockReturnValueOnce(auth.promise);
    const opening = f.presenter.start();
    f.signal.abort();
    await opening;
    expect(f.checkReconnect).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.response.commitSse).not.toHaveBeenCalled();
    expect(f.response.writes).toHaveLength(0);
    expect(f.response.listenerCount()).toBe(0);
  });

  it.each([
    ["auth", "session authentication failed"],
    ["reconnect", "reconnect rejected"],
    ["admit", "admission rejected"],
    ["subscribe", "subscription failed"],
  ] as const)("propagates %s rejection without committing or leaking", async (stage, message) => {
    const f = fixture();
    const failure = new Error(message);
    if (stage === "auth") f.authorize.mockRejectedValueOnce(failure);
    if (stage === "reconnect") f.checkReconnect.mockRejectedValueOnce(failure);
    if (stage === "admit") f.admit.mockRejectedValueOnce(failure);
    if (stage === "subscribe") f.attach.mockRejectedValueOnce(failure);
    await expect(f.presenter.start()).rejects.toBe(failure);
    expect(f.response.commitSse).not.toHaveBeenCalled();
    expect(f.response.writes).toHaveLength(0);
    expect(f.response.listenerCount()).toBe(0);
    expect(f.clock.timerCount()).toBe(0);
    if (stage !== "auth") expect(f.leaseRelease).toHaveBeenCalledTimes(stage === "subscribe" ? 1 : 0);
  });

  it("bounds auth and subscribe with abort signals and releases a late subscription", async () => {
    const auth = fixture({ limits: { authTimeoutMs: 10 } });
    const pendingAuth = deferred<never>();
    let authSignal!: AbortSignal;
    auth.authorize.mockImplementationOnce((signal) => {
      authSignal = signal;
      return pendingAuth.promise;
    });
    const authOpening = auth.presenter.start();
    await vi.waitFor(() => expect(auth.authorize).toHaveBeenCalledOnce());
    auth.clock.advance(10);
    await expect(authOpening).rejects.toMatchObject({ name: "AbortError" });
    expect(authSignal.aborted).toBe(true);
    expect(auth.response.commitSse).not.toHaveBeenCalled();
    expect(auth.response.listenerCount()).toBe(0);
    expect(auth.clock.timerCount()).toBe(0);

    const subscribe = fixture({ limits: { subscribeTimeoutMs: 10 } });
    let subscribeSignal!: AbortSignal;
    subscribe.attach.mockImplementationOnce(async (_candidate, options) => {
      subscribeSignal = options.signal;
      return subscribe.attached.promise;
    });
    const subscribeOpening = subscribe.presenter.start();
    await vi.waitFor(() => expect(subscribe.attach).toHaveBeenCalledOnce());
    subscribe.clock.advance(10);
    await expect(subscribeOpening).rejects.toMatchObject({ name: "AbortError" });
    expect(subscribeSignal.aborted).toBe(true);
    resolveAttachment(subscribe);
    await vi.waitFor(() => expect(subscribe.release).toHaveBeenCalledOnce());
    expect(subscribe.leaseRelease).toHaveBeenCalledOnce();
    expect(subscribe.response.commitSse).not.toHaveBeenCalled();
    expect(subscribe.response.writes).toHaveLength(0);
    expect(subscribe.response.listenerCount()).toBe(0);
    expect(subscribe.clock.timerCount()).toBe(0);
  });

  it("releases ownership that resolves synchronously from abort listeners after admission or subscribe abandonment", async () => {
    const admission = fixture();
    const pendingLease = deferred<RealtimeAdmissionLease>();
    const lateLeaseRelease = vi.fn(async (): Promise<void> => undefined);
    admission.admit.mockImplementationOnce(async () => {
      admission.signal.signal.addEventListener("abort", () => {
        pendingLease.resolve({ risk: admission.leaseRisk.promise, release: lateLeaseRelease });
      }, { once: true });
      return pendingLease.promise;
    });
    const admissionOpening = admission.presenter.start();
    await vi.waitFor(() => expect(admission.admit).toHaveBeenCalledOnce());
    admission.signal.abort();
    await admissionOpening;
    expect(lateLeaseRelease).toHaveBeenCalledOnce();
    expect(admission.attach).not.toHaveBeenCalled();
    expect(admission.response.commitSse).not.toHaveBeenCalled();
    expect(admission.response.writes).toHaveLength(0);
    expect(admission.response.listenerCount()).toBe(0);
    expect(admission.clock.timerCount()).toBe(0);

    const subscribe = fixture({ limits: { subscribeTimeoutMs: 10 } });
    const pendingAttachment = deferred<WorkspaceGatewayAttachment>();
    const lateAttachmentRelease = vi.fn(async (): Promise<void> => undefined);
    subscribe.attach.mockImplementationOnce(async (_candidate, { signal }) => {
      signal.addEventListener("abort", () => {
        pendingAttachment.resolve({ generation: 1, release: lateAttachmentRelease });
      }, { once: true });
      return pendingAttachment.promise;
    });
    const subscribeOpening = subscribe.presenter.start();
    await vi.waitFor(() => expect(subscribe.attach).toHaveBeenCalledOnce());
    subscribe.clock.advance(10);
    await expect(subscribeOpening).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(lateAttachmentRelease).toHaveBeenCalledOnce());
    expect(subscribe.leaseRelease).toHaveBeenCalledOnce();
    expect(subscribe.response.commitSse).not.toHaveBeenCalled();
    expect(subscribe.response.writes).toHaveLength(0);
    expect(subscribe.response.listenerCount()).toBe(0);
    expect(subscribe.clock.timerCount()).toBe(0);
  });

  it("cleans response close and shutdown while admission is deferred, releasing a late lease once", async () => {
    const f = fixture();
    const pendingAdmit = deferred<RealtimeAdmissionLease>();
    f.admit.mockImplementationOnce(async () => pendingAdmit.promise);
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.admit).toHaveBeenCalledOnce());
    f.response.emit("close");
    const lateLeaseRelease = vi.fn(async () => undefined);
    pendingAdmit.resolve({ risk: Promise.resolve({ reason: "renewal_failed", closeAtMs: 1 }), release: lateLeaseRelease });
    await opening;
    expect(lateLeaseRelease).toHaveBeenCalledOnce();
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.response.commitSse).not.toHaveBeenCalled();
    expect(f.response.writes).toHaveLength(0);
    expect(f.response.listenerCount()).toBe(0);
    expect(f.clock.timerCount()).toBe(0);

    const shutdown = fixture();
    const delayedLease = deferred<RealtimeAdmissionLease>();
    shutdown.admit.mockImplementationOnce(async () => delayedLease.promise);
    const shutdownOpening = shutdown.presenter.start();
    await vi.waitFor(() => expect(shutdown.admit).toHaveBeenCalledOnce());
    shutdown.shutdown.abort();
    const releaseLateLease = vi.fn(async () => undefined);
    delayedLease.resolve({ risk: Promise.resolve({ reason: "renewal_failed", closeAtMs: 1 }), release: releaseLateLease });
    await shutdownOpening;
    expect(releaseLateLease).toHaveBeenCalledOnce();
    expect(shutdown.attach).not.toHaveBeenCalled();
    expect(shutdown.response.listenerCount()).toBe(0);
    expect(shutdown.clock.timerCount()).toBe(0);
  });

  it("cleans response close during deferred attach and releases the late attachment and lease exactly once", async () => {
    const f = fixture();
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    f.response.emit("close");
    resolveAttachment(f);
    await opening;
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.leaseRelease).toHaveBeenCalledOnce();
    expect(f.response.commitSse).not.toHaveBeenCalled();
    expect(f.response.writes).toHaveLength(0);
    expect(f.response.listenerCount()).toBe(0);
    expect(f.clock.timerCount()).toBe(0);

    const shutdown = fixture();
    const shutdownOpening = shutdown.presenter.start();
    await vi.waitFor(() => expect(shutdown.attach).toHaveBeenCalledOnce());
    shutdown.shutdown.abort();
    resolveAttachment(shutdown);
    await shutdownOpening;
    expect(shutdown.release).toHaveBeenCalledOnce();
    expect(shutdown.leaseRelease).toHaveBeenCalledOnce();
    expect(shutdown.response.commitSse).not.toHaveBeenCalled();
    expect(shutdown.response.writes).toHaveLength(0);
    expect(shutdown.response.listenerCount()).toBe(0);
    expect(shutdown.clock.timerCount()).toBe(0);
  });

  it("balances request and shared-shutdown abort listeners across every terminal path", async () => {
    for (const terminal of ["close", "error", "finish"] as const) {
      const request = countedAbortSignal();
      const shutdown = countedAbortSignal();
      const f = fixture({
        requestController: request.controller,
        requestSignal: request.signal,
        shutdownController: shutdown.controller,
        shutdownSignal: shutdown.signal,
      });
      const opening = f.presenter.start();
      await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
      resolveAttachment(f);
      await waitForCommit(f.response);
      f.response.emit(terminal);
      await opening;
      expect.soft(request.addCount()).toBe(1);
      expect.soft(request.removeCount()).toBe(1);
      expect.soft(request.activeCount()).toBe(0);
      expect.soft(shutdown.addCount()).toBe(1);
      expect.soft(shutdown.removeCount()).toBe(1);
      expect.soft(shutdown.activeCount()).toBe(0);
      expect.soft(f.response.listenerCount()).toBe(0);
    }

    const request = countedAbortSignal();
    const shutdown = countedAbortSignal();
    const f = fixture({
      requestController: request.controller,
      requestSignal: request.signal,
      shutdownController: shutdown.controller,
      shutdownSignal: shutdown.signal,
    });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    shutdown.controller.abort();
    await opening;
    expect.soft(request.addCount()).toBe(1);
    expect.soft(request.removeCount()).toBe(1);
    expect.soft(request.activeCount()).toBe(0);
    expect.soft(shutdown.addCount()).toBe(1);
    expect.soft(shutdown.removeCount()).toBe(1);
    expect.soft(shutdown.activeCount()).toBe(0);
    expect.soft(f.response.listenerCount()).toBe(0);

    const alreadyAbortedRequest = countedAbortSignal();
    const alreadyAbortedShutdown = countedAbortSignal();
    alreadyAbortedRequest.controller.abort();
    const alreadyAborted = fixture({
      requestController: alreadyAbortedRequest.controller,
      requestSignal: alreadyAbortedRequest.signal,
      shutdownController: alreadyAbortedShutdown.controller,
      shutdownSignal: alreadyAbortedShutdown.signal,
    });
    await alreadyAborted.presenter.start();
    expect.soft(alreadyAborted.authorize).not.toHaveBeenCalled();
    expect.soft(alreadyAbortedRequest.addCount()).toBe(0);
    expect.soft(alreadyAbortedRequest.removeCount()).toBe(0);
    expect.soft(alreadyAbortedRequest.activeCount()).toBe(0);
    expect.soft(alreadyAbortedShutdown.addCount()).toBe(0);
    expect.soft(alreadyAbortedShutdown.removeCount()).toBe(0);
    expect.soft(alreadyAbortedShutdown.activeCount()).toBe(0);
    expect.soft(alreadyAborted.response.listenerCount()).toBe(0);
    expect.soft(alreadyAborted.clock.timerCount()).toBe(0);

    const liveRequest = countedAbortSignal();
    const abortedShutdown = countedAbortSignal();
    abortedShutdown.controller.abort();
    const shutdownBeforeAuthorization = fixture({
      requestController: liveRequest.controller,
      requestSignal: liveRequest.signal,
      shutdownController: abortedShutdown.controller,
      shutdownSignal: abortedShutdown.signal,
    });
    await shutdownBeforeAuthorization.presenter.start();
    expect.soft(shutdownBeforeAuthorization.authorize).not.toHaveBeenCalled();
    expect.soft(liveRequest.addCount()).toBe(1);
    expect.soft(liveRequest.removeCount()).toBe(1);
    expect.soft(liveRequest.activeCount()).toBe(0);
    expect.soft(abortedShutdown.addCount()).toBe(0);
    expect.soft(abortedShutdown.removeCount()).toBe(0);
    expect.soft(abortedShutdown.activeCount()).toBe(0);
    expect.soft(shutdownBeforeAuthorization.response.listenerCount()).toBe(0);
    expect.soft(shutdownBeforeAuthorization.clock.timerCount()).toBe(0);
  });

  it("fences a late attach after subscribe expiry, releasing both ownership handles once", async () => {
    const f = fixture({ limits: { streamAgeMs: 120_000, gatewayTimeoutMs: 120_000, edgeTimeoutMs: 120_000, subscribeTimeoutMs: 30_000 } });
    f.authorize.mockResolvedValueOnce({ accountId, workspaceId, principalId, sessionExpiresAt: new Date(f.clock.wallNow() + 50_000) });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    f.clock.advance(21_000);
    resolveAttachment(f);
    await opening;
    expect(f.response.commitSse).not.toHaveBeenCalled();
    expect(f.response.writes).toHaveLength(0);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.leaseRelease).toHaveBeenCalledOnce();
    expect(f.response.listenerCount()).toBe(0);
    expect(f.clock.timerCount()).toBe(0);
  });

  it("rejects an already-due effective expiry before commit and releases admission", async () => {
    const f = fixture({ limits: { streamAgeMs: 120_000, gatewayTimeoutMs: 120_000, edgeTimeoutMs: 120_000 } });
    f.authorize.mockResolvedValueOnce({ accountId, workspaceId, principalId, sessionExpiresAt: new Date(f.clock.wallNow() + 50_000) });
    const pendingAdmit = deferred<RealtimeAdmissionLease>();
    f.admit.mockImplementationOnce(async () => pendingAdmit.promise);
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.admit).toHaveBeenCalledOnce());
    f.clock.advance(21_000);
    pendingAdmit.resolve({ risk: f.leaseRisk.promise, release: f.leaseRelease });
    await opening;
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.response.commitSse).not.toHaveBeenCalled();
    expect(f.response.writes).toHaveLength(0);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.leaseRelease).toHaveBeenCalledOnce();
    expect(f.clock.timerCount()).toBe(0);
  });

  it("uses the minimum of sampled age, session, gateway, and edge limits from request start", async () => {
    const f = fixture({ limits: { streamAgeMs: 120_000, gatewayTimeoutMs: 75_000, edgeTimeoutMs: 90_000 } });
    f.authorize.mockResolvedValueOnce({ accountId, workspaceId, principalId, sessionExpiresAt: new Date(f.clock.wallNow() + 90_000) });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    f.clock.jumpWall(7 * 24 * 60 * 60_000);
    resolveAttachment(f);
    await waitForCommit(f.response);
    f.clock.advance(44_999);
    expect(f.response.ended).toBe(false);
    f.clock.advance(1);
    expect(f.response.ended).toBe(true);
    await opening;
    expect(f.clock.maxOutstandingTimers()).toBeLessThanOrEqual(1);
    expect(f.clock.timerCount()).toBe(0);
  });

  it.each([
    ["sampled stream age", 20_000, 120_000, 200_000, 200_000, 20_000],
    ["session expiry minus safety", 120_000, 50_000, 200_000, 200_000, 20_000],
    ["gateway timeout minus safety", 120_000, 120_000, 50_000, 200_000, 20_000],
    ["edge timeout minus safety", 120_000, 120_000, 200_000, 50_000, 20_000],
  ] as const)("uses %s as the winning effective expiry limiter", async (_winner, age, sessionAge, gateway, edge, expected) => {
    const f = fixture({ limits: { streamAgeMs: age, gatewayTimeoutMs: gateway, edgeTimeoutMs: edge } });
    f.authorize.mockResolvedValueOnce({ accountId, workspaceId, principalId, sessionExpiresAt: new Date(f.clock.wallNow() + sessionAge) });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    f.clock.advance(expected - 1);
    expect(f.response.end).not.toHaveBeenCalled();
    f.clock.advance(1);
    expect(f.response.end).toHaveBeenCalledOnce();
    await opening;
    expect(f.clock.maxOutstandingTimers()).toBeLessThanOrEqual(1);
    expect(f.clock.timerCount()).toBe(0);
  });

  it("counts preflight delay against the request-start lifetime and ignores wall-clock jumps", async () => {
    const f = fixture({ limits: { streamAgeMs: 20_000, gatewayTimeoutMs: 120_000, edgeTimeoutMs: 120_000, authTimeoutMs: 30_000 } });
    const auth = deferred<{ accountId: string; workspaceId: string; principalId: string; sessionExpiresAt: Date }>();
    const attachmentRelease = vi.fn(async (): Promise<void> => undefined);
    f.authorize.mockReturnValueOnce(auth.promise);
    f.attach.mockResolvedValueOnce({ generation: 1, release: attachmentRelease });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.authorize).toHaveBeenCalledOnce());
    f.clock.advance(21_000);
    f.clock.jumpWall(-7 * 24 * 60 * 60_000);
    auth.resolve({ accountId, workspaceId, principalId, sessionExpiresAt: new Date(f.clock.wallNow() + 120_000) });
    await opening;
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.response.commitSse).not.toHaveBeenCalled();
    expect(f.response.writes).toHaveLength(0);
    expect(f.leaseRelease).toHaveBeenCalledOnce();
    expect(attachmentRelease).not.toHaveBeenCalled();
  });

  it("observes lease risk immediately: precommit fails closed, postcommit closes at its monotonic deadline", async () => {
    const precommit = fixture();
    const opening = precommit.presenter.start();
    await vi.waitFor(() => expect(precommit.admit).toHaveBeenCalledOnce());
    precommit.leaseRisk.resolve({ reason: "renewal_failed", closeAtMs: 1 });
    await vi.waitFor(() => expect(precommit.leaseRelease).toHaveBeenCalledOnce());
    expect(precommit.response.commitSse).not.toHaveBeenCalled();
    resolveAttachment(precommit);
    await opening;

    const postcommit = fixture();
    const live = postcommit.presenter.start();
    await vi.waitFor(() => expect(postcommit.attach).toHaveBeenCalledOnce());
    resolveAttachment(postcommit);
    await waitForCommit(postcommit.response);
    postcommit.leaseRisk.resolve({ reason: "renewal_failed", closeAtMs: 500 });
    await Promise.resolve();
    postcommit.clock.advance(499);
    expect(postcommit.response.ended).toBe(false);
    postcommit.clock.advance(1);
    expect(postcommit.response.ended).toBe(true);
    await live;
  });

  it("writes each ready/invalidate/resync frame as one bounded buffer and one write", async () => {
    const f = fixture();
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    f.connection?.enqueueInvalidation(invalidation);
    await vi.waitFor(() => expect(f.response.writes).toHaveLength(2));
    expect(frameText(f.response.writes[1]!)).toBe('event: invalidate\ndata: {"protocolVersion":1,"changeKinds":["crawl.progress"]}\n\n');
    expect(f.response.writes.every((frame) => frame.byteLength <= 4 * 1024)).toBe(true);
    f.response.emit("close");
    await opening;
  });

  it("rejects an encoded frame above the byte cap without writing it", async () => {
    const f = fixture({ limits: { frameBytes: 64 } });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    f.connection?.enqueueInvalidation(INVALIDATION_KINDS);
    await vi.waitFor(() => expect(f.response.destroy).toHaveBeenCalledOnce());
    expect(f.response.writes).toHaveLength(1);
    expect(frameText(f.response.writes[0]!)).toContain("event: ready");
    await opening;
  });

  it("keeps false writes blocked until one drain and makes resync dominate invalidate plus heartbeat", async () => {
    const f = fixture({ limits: { blockedDurationMs: 30_000 } });
    f.response.configureWrite({ blocked: true, writableLength: 0 });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    expect(f.response.writes).toHaveLength(1);
    expect(f.response.listenerCount("drain")).toBe(1);
    f.connection?.enqueueInvalidation(invalidation);
    f.clock.advance(20_000);
    f.connection?.enqueueResync();
    f.connection?.enqueueInvalidation(["document.status_changed"]);
    expect(f.response.writes).toHaveLength(1);
    f.response.blockWrites(false);
    f.response.emit("drain");
    await vi.waitFor(() => expect(f.response.writes).toHaveLength(2));
    expect(frameText(f.response.writes[1]!)).toBe('event: resync\ndata: {"protocolVersion":1}\n\n');
    expect(f.response.listenerCount("drain")).toBe(0);
    expect(f.response.maxDrainListeners()).toBe(1);
    expect(f.response.maxWritesInFlight()).toBe(1);
    expect(f.clock.maxOutstandingTimers()).toBeLessThanOrEqual(1);
    f.response.emit("close");
    await opening;
  });

  it("does not replay an accepted data marker after false write and preserves a later marker", async () => {
    const f = fixture({ limits: { blockedDurationMs: 30_000 } });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);

    f.response.blockWrites(true);
    f.connection?.enqueueResync();
    await vi.waitFor(() => expect(f.response.writes).toHaveLength(2));
    expect(frameText(f.response.writes[1]!)).toBe('event: resync\ndata: {"protocolVersion":1}\n\n');

    f.connection?.enqueueInvalidation(invalidation);
    f.response.blockWrites(false);
    f.response.emit("drain");
    await Promise.resolve();
    f.response.emit("close");
    await opening;

    expect(f.response.writes).toHaveLength(3);
    expect(frameText(f.response.writes[2]!)).toBe('event: invalidate\ndata: {"protocolVersion":1,"changeKinds":["crawl.progress"]}\n\n');
    expect(f.response.writes.filter((frame) => frameText(frame).startsWith("event: resync")).length).toBe(1);
  });

  it("coalesces heartbeat and reentrant mailbox enqueue without losing a marker", async () => {
    const f = fixture();
    const originalWrite = f.response.write.getMockImplementation()!;
    f.response.write.mockImplementationOnce((frame) => {
      const accepted = originalWrite(frame);
      f.connection?.enqueueInvalidation(invalidation);
      return accepted;
    });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    f.clock.advance(20_000);
    await vi.waitFor(() => expect(f.response.writes.length).toBeGreaterThanOrEqual(2));
    expect(f.response.writes.filter((frame) => frameText(frame).startsWith(": heartbeat")).length).toBeLessThanOrEqual(1);
    expect(f.response.writes.some((frame) => frameText(frame).includes('"crawl.progress"'))).toBe(true);
    f.response.emit("close");
    await opening;
  });

  it("evicts at blocked byte/time thresholds, with one pump, drain listener, timer, and final zero cleanup", async () => {
    const f = fixture({ limits: { streamAgeMs: 60_000, gatewayTimeoutMs: 120_000, edgeTimeoutMs: 120_000, blockedDurationMs: 10_000, blockedWritableBytes: 256 } });
    f.response.configureWrite({ blocked: true, writableLength: 255 });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    expect(f.response.listenerCount("drain")).toBe(1);
    expect(f.response.destroy).not.toHaveBeenCalled();
    expect(f.response.maxDrainListeners()).toBe(1);
    expect(f.response.maxWritesInFlight()).toBe(1);
    expect(f.clock.maxOutstandingTimers()).toBeLessThanOrEqual(1);
    f.clock.advance(9_999);
    expect(f.response.destroy).not.toHaveBeenCalled();
    f.response.setWritableLength(256);
    f.clock.advance(1);
    expect(f.response.destroy).toHaveBeenCalledOnce();
    expect(f.response.listenerCount()).toBe(0);
    expect(f.clock.timerCount()).toBe(0);
    await opening;

    const byTime = fixture({ limits: { streamAgeMs: 60_000, gatewayTimeoutMs: 120_000, edgeTimeoutMs: 120_000, blockedDurationMs: 10_000, blockedWritableBytes: 256 } });
    byTime.response.configureWrite({ blocked: true, writableLength: 0 });
    const second = byTime.presenter.start();
    await vi.waitFor(() => expect(byTime.attach).toHaveBeenCalledOnce());
    resolveAttachment(byTime);
    await waitForCommit(byTime.response);
    byTime.clock.advance(9_999);
    expect(byTime.response.destroy).not.toHaveBeenCalled();
    byTime.clock.advance(1);
    expect(byTime.response.destroy).toHaveBeenCalledOnce();
    await second;
  });

  it("evicts immediately when writableLength is already at the blocked boundary during a false write", async () => {
    const f = fixture({ limits: { blockedWritableBytes: 256 } });
    f.response.configureWrite({ blocked: true, writableLength: 256 });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    expect(f.response.destroy).toHaveBeenCalledOnce();
    expect(f.response.writes).toHaveLength(1);
    expect(f.response.listenerCount()).toBe(0);
    expect(f.clock.timerCount()).toBe(0);
    await opening;
  });

  it("destroys immediately when a successful data write reaches the hard writable cap", async () => {
    const f = fixture({ limits: { blockedWritableBytes: 256 } });
    f.response.configureWrite({ blocked: false, writableLength: 256 });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    await Promise.resolve();
    if (!f.response.destroyed) f.response.emit("close");
    await opening;
    expect(f.response.destroy).toHaveBeenCalledOnce();
    expect(f.response.writes).toHaveLength(1);
    expect(f.response.listenerCount()).toBe(0);
  });

  it("closes on thrown writes, and never restores a stream after write(false)", async () => {
    const f = fixture();
    f.response.configureWrite({ blocked: true, writableLength: 0 });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    f.response.configureWrite({ blocked: false, writableLength: 0 });
    f.response.emit("drain");
    f.response.write.mockImplementationOnce(() => { throw new Error("socket failed"); });
    f.connection?.enqueueInvalidation(invalidation);
    await vi.waitFor(() => expect(f.response.destroy).toHaveBeenCalledOnce());
    expect(f.response.ended).toBe(false);
    await opening;
  });

  it("releases attachment and lease exactly once for every terminal response event, even when release rejects", async () => {
    for (const event of ["close", "error", "finish"] as const) {
      const f = fixture();
      f.leaseRelease.mockRejectedValueOnce(new Error("lease release failed"));
      f.release.mockRejectedValueOnce(new Error("gateway release failed"));
      const opening = f.presenter.start();
      await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
      resolveAttachment(f);
      await waitForCommit(f.response);
      f.response.emit(event);
      f.response.emit(event);
      await opening;
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.leaseRelease).toHaveBeenCalledOnce();
      expect(f.response.listenerCount()).toBe(0);
      expect(f.clock.timerCount()).toBe(0);
      if (event === "close" || event === "finish") {
        expect(f.response.end).not.toHaveBeenCalled();
        expect(f.response.destroy).not.toHaveBeenCalled();
      }
    }
  });

  it("starts attachment and lease release concurrently for close+error+shutdown, even when one stalls", async () => {
    const f = fixture();
    const gatewayRelease = deferred<void>();
    const leaseRelease = deferred<void>();
    f.release.mockImplementationOnce(() => gatewayRelease.promise);
    f.leaseRelease.mockImplementationOnce(() => leaseRelease.promise);
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    f.response.emit("close");
    f.response.emit("error");
    f.shutdown.abort();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.leaseRelease).toHaveBeenCalledOnce();
    expect(f.response.end).not.toHaveBeenCalled();
    expect(f.response.destroy).not.toHaveBeenCalled();
    gatewayRelease.resolve();
    leaseRelease.reject(new Error("lease release failed"));
    await opening;
    expect(f.response.listenerCount()).toBe(0);
    expect(f.clock.timerCount()).toBe(0);
  });

  it("propagates a commit failure after fencing the stream and releasing both ownership handles", async () => {
    const f = fixture();
    const failure = new Error("commit failed");
    f.response.commitSse.mockImplementationOnce(() => { throw failure; });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await expect(opening).rejects.toBe(failure);
    expect(f.response.write).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.leaseRelease).toHaveBeenCalledOnce();
    expect(f.response.listenerCount()).toBe(0);
    expect(f.clock.timerCount()).toBe(0);
  });

  it("aborts and cleans preflight, attached dependency, and runtime shutdown paths", async () => {
    const preflight = fixture();
    const pendingAuth = deferred<never>();
    preflight.authorize.mockReturnValueOnce(pendingAuth.promise);
    const first = preflight.presenter.start();
    preflight.shutdown.abort();
    await first;
    expect(preflight.admit).not.toHaveBeenCalled();
    expect(preflight.response.commitSse).not.toHaveBeenCalled();

    const attached = fixture();
    const second = attached.presenter.start();
    await vi.waitFor(() => expect(attached.attach).toHaveBeenCalledOnce());
    resolveAttachment(attached);
    await waitForCommit(attached.response);
    attached.shutdown.abort();
    await second;
    expect(attached.release).toHaveBeenCalledOnce();
    expect(attached.leaseRelease).toHaveBeenCalledOnce();
    expect(attached.response.end).toHaveBeenCalledOnce();
    expect(attached.response.listenerCount()).toBe(0);
  });

  it("uses planned expiry end, destroys slow/write failures, and distinguishes remote close from gateway close", async () => {
    const planned = fixture({ limits: { streamAgeMs: 1_000, gatewayTimeoutMs: 120_000, edgeTimeoutMs: 120_000 } });
    const first = planned.presenter.start();
    await vi.waitFor(() => expect(planned.attach).toHaveBeenCalledOnce());
    resolveAttachment(planned);
    await waitForCommit(planned.response);
    planned.clock.advance(1_000);
    expect(planned.response.end).toHaveBeenCalledOnce();
    expect(planned.response.destroy).not.toHaveBeenCalled();
    await first;

    const remote = fixture();
    const second = remote.presenter.start();
    await vi.waitFor(() => expect(remote.attach).toHaveBeenCalledOnce());
    resolveAttachment(remote);
    await waitForCommit(remote.response);
    remote.response.emit("close");
    await second;
    expect(remote.response.end).not.toHaveBeenCalled();
    expect(remote.response.destroy).not.toHaveBeenCalled();
    expect(remote.response.writes).toHaveLength(1);

    for (const reason of ["shutdown", "superseded", "transport_lost"] as const) {
      const gatewayClose = fixture();
      const closing = gatewayClose.presenter.start();
      await vi.waitFor(() => expect(gatewayClose.attach).toHaveBeenCalledOnce());
      resolveAttachment(gatewayClose);
      await waitForCommit(gatewayClose.response);
      const requestClose = gatewayClose.connection?.requestClose as (closeReason: WorkspaceGatewayCloseReason | "transport_lost") => void;
      requestClose(reason);
      await closing;
      expect(gatewayClose.response.end).toHaveBeenCalledOnce();
      expect(gatewayClose.response.destroy).not.toHaveBeenCalled();
      expect(gatewayClose.response.writes).toHaveLength(1);
      expect(gatewayClose.release).toHaveBeenCalledOnce();
      expect(gatewayClose.leaseRelease).toHaveBeenCalledOnce();
    }
  });

  it("does not write after remote close, including a later drain, and finish does not end an active response", async () => {
    const f = fixture();
    f.response.configureWrite({ blocked: true, writableLength: 0 });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    f.response.emit("close");
    f.response.emit("drain");
    f.response.emit("finish");
    await opening;
    expect(f.response.writes).toHaveLength(1);
    expect(f.response.end).not.toHaveBeenCalled();
    expect(f.response.destroy).not.toHaveBeenCalled();
    expect(f.response.listenerCount()).toBe(0);
  });

  it("emits only fixed-card stream telemetry for active/blocked/backlog, lifecycle counters, and durations", async () => {
    const telemetry = {
      gaugeDelta: vi.fn(),
      counter: vi.fn(),
      histogram: vi.fn(),
    };
    const f = fixture({ telemetry });
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    resolveAttachment(f);
    await waitForCommit(f.response);
    f.response.emit("close");
    await opening;
    expect(telemetry.counter).toHaveBeenCalledWith("opened");
    expect(telemetry.counter).toHaveBeenCalledWith("ready");
    expect(telemetry.counter).toHaveBeenCalledWith("closed");
    expect(telemetry.gaugeDelta).toHaveBeenCalledWith("active", 1);
    expect(telemetry.gaugeDelta).toHaveBeenCalledWith("active", -1);
    expect(telemetry.gaugeDelta.mock.calls.filter(([name, delta]) => name === "active" && delta === 1)).toHaveLength(1);
    expect(telemetry.gaugeDelta.mock.calls.filter(([name, delta]) => name === "active" && delta === -1)).toHaveLength(1);
    expect(telemetry.gaugeDelta).not.toHaveBeenCalledWith("active", 0);
    expect(telemetry.gaugeDelta).not.toHaveBeenCalledWith("blocked", 0);
    expect(telemetry.histogram).toHaveBeenCalledWith("time_to_ready", expect.any(Number));
    expect(telemetry.histogram).toHaveBeenCalledWith("lifetime", expect.any(Number));
    expect(telemetry.histogram).toHaveBeenCalledWith("backlog", expect.any(Number));

    const slowTelemetry = { gaugeDelta: vi.fn(), counter: vi.fn(), histogram: vi.fn() };
    const slow = fixture({ telemetry: slowTelemetry });
    slow.response.configureWrite({ blocked: true, writableLength: 0 });
    const slowOpening = slow.presenter.start();
    await vi.waitFor(() => expect(slow.attach).toHaveBeenCalledOnce());
    resolveAttachment(slow);
    await waitForCommit(slow.response);
    slow.clock.advance(defaultLimits.blockedDurationMs);
    await slowOpening;
    expect(slowTelemetry.counter).toHaveBeenCalledWith("slow");
    expect(slowTelemetry.counter).toHaveBeenCalledWith("closed");
    expect(slowTelemetry.gaugeDelta).toHaveBeenCalledWith("active", 1);
    expect(slowTelemetry.gaugeDelta).toHaveBeenCalledWith("active", -1);
    expect(slowTelemetry.gaugeDelta).toHaveBeenCalledWith("blocked", 1);
    expect(slowTelemetry.gaugeDelta).toHaveBeenCalledWith("blocked", -1);
    expect(slowTelemetry.gaugeDelta.mock.calls.filter(([name, delta]) => name === "active" && delta === 1)).toHaveLength(1);
    expect(slowTelemetry.gaugeDelta.mock.calls.filter(([name, delta]) => name === "active" && delta === -1)).toHaveLength(1);
    expect(slowTelemetry.gaugeDelta.mock.calls.filter(([name, delta]) => name === "blocked" && delta === 1)).toHaveLength(1);
    expect(slowTelemetry.gaugeDelta.mock.calls.filter(([name, delta]) => name === "blocked" && delta === -1)).toHaveLength(1);
    expect(slowTelemetry.gaugeDelta).not.toHaveBeenCalledWith("active", 0);
    expect(slowTelemetry.gaugeDelta).not.toHaveBeenCalledWith("blocked", 0);
    expect(slowTelemetry.histogram).toHaveBeenCalledWith("blocked_duration", expect.any(Number));

    const expiredTelemetry = { gaugeDelta: vi.fn(), counter: vi.fn(), histogram: vi.fn() };
    const expired = fixture({ telemetry: expiredTelemetry, limits: { streamAgeMs: 1_000 } });
    const expiredOpening = expired.presenter.start();
    await vi.waitFor(() => expect(expired.attach).toHaveBeenCalledOnce());
    resolveAttachment(expired);
    await waitForCommit(expired.response);
    expired.clock.advance(1_000);
    await expiredOpening;
    expect(expiredTelemetry.counter).toHaveBeenCalledWith("expired");
    expect(expiredTelemetry.counter).toHaveBeenCalledWith("closed");

    const args = JSON.stringify([
      telemetry.gaugeDelta.mock.calls,
      telemetry.counter.mock.calls,
      telemetry.histogram.mock.calls,
    ]);
    expect(args).not.toContain(workspaceId);
    expect(args).not.toContain("crawl.progress");
    expect(args).not.toContain("event: invalidate");
  });

  it("keeps the presenter mailbox isolated, bounded, and free of Express/provider dependencies", async () => {
    const f = fixture();
    const opening = f.presenter.start();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledOnce());
    const connection = f.connection!;
    expect(connection.connectionId).toEqual(expect.any(String));
    expect(connection.workspaceId).toBe(workspaceId);
    connection.enqueueInvalidation(["crawl.progress", "crawl.progress"]);
    connection.enqueueResync();
    connection.enqueueInvalidation(["document.status_changed"]);
    resolveAttachment(f);
    await waitForCommit(f.response);
    await vi.waitFor(() => expect(f.response.writes.length).toBeGreaterThan(1));
    expect(f.response.writes.filter((frame) => frame.byteLength > 4 * 1024)).toHaveLength(0);
    f.response.emit("close");
    await opening;
    expect(f.leaseRelease).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
});
