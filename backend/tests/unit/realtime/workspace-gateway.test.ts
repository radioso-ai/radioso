import { describe, expect, it, vi } from "vitest";

import { WorkspaceGateway, type WorkspaceGatewayConnection } from "../../../src/modules/realtime/application/workspaceGateway.js";
import { RealtimeSession } from "../../../src/modules/realtime/domain/realtimeSession.js";
import type {
  WorkspaceInterestContinuitySource,
  WorkspaceInterestTransport,
} from "../../../src/modules/realtime/domain/contracts.js";

const workspaceA = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
const workspaceB = "3e07ced1-9c3d-492a-b7cf-a885334df88d";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
};

const fixture = () => {
  const listeners = new Map<string, (kinds: readonly string[]) => void>();
  const continuityListeners = new Set<(event: { generation: number; state: "lost" | "restored" }) => void>();
  const subscribe = vi.fn(async (workspaceId: string, listener: (kinds: readonly string[]) => void) => {
    listeners.set(workspaceId, listener);
    return { generation: 0 };
  });
  const unsubscribe = vi.fn(async (workspaceId: string, listener: (kinds: readonly string[]) => void) => {
    expect(listeners.get(workspaceId)).toBe(listener);
    listeners.delete(workspaceId);
  });
  const continuity: WorkspaceInterestContinuitySource = {
    onContinuity: (listener) => {
      continuityListeners.add(listener);
      return () => continuityListeners.delete(listener);
    },
  };
  return {
    transport: { subscribe, unsubscribe } as unknown as WorkspaceInterestTransport,
    continuity,
    subscribe,
    unsubscribe,
    listeners,
    continuityListeners,
    emitContinuity: (event: { generation: number; state: "lost" | "restored" }) => {
      for (const listener of continuityListeners) listener(event);
    },
  };
};

const connection = (connectionId: string, workspaceId = workspaceA) => {
  const session = new RealtimeSession({ connectionId, workspaceId });
  return {
    connectionId,
    workspaceId,
    enqueueInvalidation: (kinds) => session.mergeInvalidation(kinds),
    enqueueResync: () => session.requireResync(),
    requestClose: vi.fn((_reason: "superseded" | "shutdown"): void => { session.close(); }),
    pending: () => session.pending(),
  } satisfies WorkspaceGatewayConnection & { pending(): ReturnType<RealtimeSession["pending"]> };
};

describe("WorkspaceGateway RED contract", () => {
  it("keeps one bounded workspace interest/listener and one serialized command chain", async () => {
    const f = fixture();
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1 });
    const leftSession = connection("left");
    const rightSession = connection("right");
    const left = await gateway.attach(leftSession);
    const right = await gateway.attach(rightSession);
    expect(f.subscribe).toHaveBeenCalledOnce();
    f.listeners.get(workspaceA)?.(["crawl.progress"]);
    expect(leftSession.pending()).toEqual({ type: "invalidate", changeKinds: ["crawl.progress"] });
    expect(rightSession.pending()).toEqual({ type: "invalidate", changeKinds: ["crawl.progress"] });
    await left.release();
    await right.release();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("records low-cardinality gateway interest lifecycle telemetry", async () => {
    const f = fixture();
    const telemetry = { event: vi.fn(), state: vi.fn() };
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1, telemetry });
    const handle = await gateway.attach(connection("one"));
    expect(telemetry.state).toHaveBeenCalledWith({ interests: 1, sessions: 1, waiters: 0 });
    expect(telemetry.event).toHaveBeenCalledWith("subscribed");
    f.emitContinuity({ generation: 1, state: "lost" });
    f.emitContinuity({ generation: 1, state: "restored" });
    expect(telemetry.event).toHaveBeenCalledWith("resync");
    await handle.release();
    expect(telemetry.event).toHaveBeenCalledWith("released");
    expect(telemetry.state).toHaveBeenLastCalledWith({ interests: 0, sessions: 0, waiters: 0 });
  });

  it("single-flights first attach: one aborts while the other survives", async () => {
    const first = deferred<{ generation: number }>();
    const f = fixture();
    f.subscribe.mockImplementationOnce(async (workspaceId, listener) => {
      f.listeners.set(workspaceId, listener);
      return first.promise;
    });
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1 });
    const oneAbort = new AbortController();
    const one = gateway.attach(connection("one"), { signal: oneAbort.signal });
    const twoSession = connection("two");
    const two = gateway.attach(twoSession);
    await vi.waitFor(() => expect(f.subscribe).toHaveBeenCalledOnce());
    oneAbort.abort();
    let oneSettled = false;
    let twoSettled = false;
    void one.then(() => { oneSettled = true; }, () => { oneSettled = true; });
    void two.then(() => { twoSettled = true; }, () => { twoSettled = true; });
    await vi.waitFor(() => {
      expect(oneSettled).toBe(true);
      expect(twoSettled).toBe(false);
    });
    first.resolve({ generation: 0 });
    await expect(one).rejects.toMatchObject({ name: "AbortError" });
    await expect(two).resolves.toMatchObject({ generation: 0 });
    f.listeners.get(workspaceA)?.(["crawl.progress"]);
    expect(twoSession.pending()).toEqual({ type: "invalidate", changeKinds: ["crawl.progress"] });
    await two.then((handle) => handle.release());
    expect(f.unsubscribe).toHaveBeenCalledOnce();

    const both = fixture();
    const secondAck = deferred<{ generation: number }>();
    both.subscribe.mockImplementationOnce(async (workspaceId, listener) => {
      both.listeners.set(workspaceId, listener);
      return secondAck.promise;
    });
    const retryGateway = new WorkspaceGateway({ transport: both.transport, continuity: both.continuity, maxWorkspaces: 1 });
    const abortA = new AbortController();
    const abortB = new AbortController();
    const pendingA = retryGateway.attach(connection("a"), { signal: abortA.signal });
    const pendingB = retryGateway.attach(connection("b"), { signal: abortB.signal });
    await vi.waitFor(() => expect(both.subscribe).toHaveBeenCalledOnce());
    abortA.abort(); abortB.abort();
    let aSettled = false;
    let bSettled = false;
    void pendingA.then(() => { aSettled = true; }, () => { aSettled = true; });
    void pendingB.then(() => { bSettled = true; }, () => { bSettled = true; });
    await vi.waitFor(() => {
      expect(aSettled).toBe(true);
      expect(bSettled).toBe(true);
    });
    secondAck.resolve({ generation: 0 });
    await expect(pendingA).rejects.toMatchObject({ name: "AbortError" });
    await expect(pendingB).rejects.toMatchObject({ name: "AbortError" });
    expect(both.unsubscribe).toHaveBeenCalledOnce();
  });

  it("uses token-bound ABA-safe idempotent release and cancels delayed release on reattach", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1, releaseGraceMs: 50 });
    const firstSession = connection("same");
    const closeSpy = vi.spyOn(firstSession, "requestClose");
    const first = await gateway.attach(firstSession);
    const secondSession = connection("same");
    const second = await gateway.attach(secondSession);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(closeSpy).toHaveBeenCalledWith("superseded");
    const staleRelease = first.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    await staleRelease;
    f.listeners.get(workspaceA)?.(["crawl.progress"]);
    expect(secondSession.pending()).toEqual({ type: "invalidate", changeKinds: ["crawl.progress"] });
    await second.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    await second.release();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("fences a reentrant superseded release before requesting the old connection close", async () => {
    const f = fixture();
    const telemetry = { event: vi.fn(), state: vi.fn() };
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1, telemetry });
    const oldConnection = connection("same");
    const old = await gateway.attach(oldConnection);
    oldConnection.requestClose.mockImplementationOnce(() => { void old.release(); });

    const replacement = connection("same");
    const next = await gateway.attach(replacement);

    expect(f.subscribe).toHaveBeenCalledOnce();
    expect(f.unsubscribe).not.toHaveBeenCalled();
    expect(telemetry.state).toHaveBeenLastCalledWith({ interests: 1, sessions: 1, waiters: 0 });
    f.listeners.get(workspaceA)?.(["crawl.progress"]);
    expect(replacement.pending()).toEqual({ type: "invalidate", changeKinds: ["crawl.progress"] });
    await next.release();
  });

  it("cancels a sole release grace timer when the workspace is reattached before its deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1, releaseGraceMs: 50 });
    const first = await gateway.attach(connection("first"));
    await first.release();
    const second = await gateway.attach(connection("second"));
    await vi.advanceTimersByTimeAsync(100);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    await second.release();
    vi.useRealTimers();
  });

  it("waits for unsubscribe acknowledgement before a new attach re-subscribes the exact listener", async () => {
    const releaseAck = deferred<void>();
    const releaseFailure = deferred<void>();
    const f = fixture();
    f.unsubscribe.mockImplementationOnce(async (workspaceId, listener) => {
      expect(f.listeners.get(workspaceId)).toBe(listener);
      f.listeners.delete(workspaceId);
      await releaseAck.promise;
      await releaseFailure.promise;
      throw new Error("lost unsubscribe reply");
    });
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1, releaseGraceMs: 0 });
    const first = await gateway.attach(connection("one"));
    const closing = first.release();
    await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledOnce());
    const next = gateway.attach(connection("two"));
    expect(f.subscribe).toHaveBeenCalledOnce();
    releaseAck.resolve();
    releaseFailure.resolve();
    await expect(closing).rejects.toThrow("lost unsubscribe reply");
    await expect(next).resolves.toMatchObject({ generation: 0 });
    expect(f.subscribe).toHaveBeenCalledTimes(2);
  });

  it("cleans failed subscribe state and permits a later attach", async () => {
    const f = fixture();
    f.subscribe.mockRejectedValueOnce(new Error("broker unavailable"));
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1 });
    await expect(gateway.attach(connection("one"))).rejects.toThrow("broker unavailable");
    await expect(gateway.attach(connection("two"))).resolves.toMatchObject({ generation: 0 });
    expect(f.subscribe).toHaveBeenCalledTimes(2);
  });

  it("fans out by workspace index without unrelated scans and coalesces hot-workspace markers", async () => {
    const f = fixture();
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 2 });
    const aSession = connection("a", workspaceA);
    const bSession = connection("b", workspaceB);
    const a = await gateway.attach(aSession);
    const b = await gateway.attach(bSession);
    f.listeners.get(workspaceA)?.(["crawl.progress"]);
    f.listeners.get(workspaceA)?.(["crawl.status_changed"]);
    expect(aSession.pending()).toEqual({ type: "invalidate", changeKinds: ["crawl.progress", "crawl.status_changed"] });
    expect(bSession.pending()).toBeUndefined();
    await a.release();
    await b.release();
  });

  it("does not resolve attach until subscription generation is ready", async () => {
    const pending = deferred<{ generation: number }>();
    const f = fixture();
    f.subscribe.mockImplementationOnce(async (workspaceId, listener) => {
      f.listeners.set(workspaceId, listener);
      return pending.promise;
    });
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1 });
    const opening = gateway.attach(connection("one"));
    await Promise.resolve();
    expect(f.subscribe).toHaveBeenCalledOnce();
    pending.resolve({ generation: 7 });
    await expect(opening).resolves.toMatchObject({ generation: 7 });
  });

  it("uses one continuity listener, ignores mismatched generations, and resyncs only pre-loss sessions", async () => {
    const f = fixture();
    f.subscribe.mockImplementation(async (workspaceId, listener) => {
      f.listeners.set(workspaceId, listener);
      return { generation: f.subscribe.mock.calls.length === 1 ? 0 : 1 };
    });
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1 });
    const oldSession = connection("old");
    const old = await gateway.attach(oldSession);
    expect(f.continuityListeners.size).toBe(1);
    f.emitContinuity({ generation: 1, state: "lost" });
    const newSession = connection("new");
    const pendingNew = gateway.attach(newSession);
    await Promise.resolve();
    expect(f.subscribe).toHaveBeenCalledOnce();
    f.emitContinuity({ generation: 2, state: "restored" });
    await Promise.resolve();
    expect(oldSession.pending()).toBeUndefined();
    expect(f.subscribe).toHaveBeenCalledOnce();
    f.emitContinuity({ generation: 1, state: "restored" });
    await expect(pendingNew).resolves.toMatchObject({ generation: 1 });
    expect(oldSession.pending()).toEqual({ type: "resync" });
    expect(newSession.pending()).toBeUndefined();
    await old.release();
    await pendingNew.then((handle) => handle.release());
  });

  it("keeps pending attach abortable during continuity loss and shuts down with exact cleanup", async () => {
    const f = fixture();
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1 });
    const old = await gateway.attach(connection("old"));
    f.emitContinuity({ generation: 1, state: "lost" });
    const abort = new AbortController();
    const pending = gateway.attach(connection("new"), { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await gateway.shutdown();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    await old.release();
    expect(f.continuityListeners.size).toBe(0);
    await gateway.shutdown();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("drops aborted readiness registrations by token across repeated continuity loss", async () => {
    const f = fixture();
    const telemetry = { event: vi.fn(), state: vi.fn() };
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1, telemetry });
    const ready = connection("ready");
    const live = await gateway.attach(ready);
    f.emitContinuity({ generation: 1, state: "lost" });
    const abort = new AbortController();
    const abandoned = connection("reused");
    const aborted = gateway.attach(abandoned, { signal: abort.signal });
    abort.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    f.emitContinuity({ generation: 2, state: "lost" });
    const replacement = connection("reused");
    const opening = gateway.attach(replacement);
    f.emitContinuity({ generation: 2, state: "restored" });
    await expect(opening).resolves.toMatchObject({ generation: 2 });
    expect(ready.pending()).toEqual({ type: "resync" });
    expect(abandoned.pending()).toBeUndefined();
    expect(replacement.pending()).toBeUndefined();
    await live.release();
    await opening.then((handle) => handle.release());
    expect(telemetry.state).toHaveBeenLastCalledWith({ interests: 0, sessions: 0, waiters: 0 });
  });

  it("resyncs only attachments that were ready before each continuity loss", async () => {
    const subscribeAck = deferred<{ generation: number }>();
    const f = fixture();
    f.subscribe.mockImplementationOnce(async (workspaceId, listener) => {
      f.listeners.set(workspaceId, listener);
      return subscribeAck.promise;
    });
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1 });
    const pendingConnection = connection("pending");
    const opening = gateway.attach(pendingConnection);
    await vi.waitFor(() => expect(f.subscribe).toHaveBeenCalledOnce());
    f.emitContinuity({ generation: 1, state: "lost" });
    subscribeAck.resolve({ generation: 0 });
    f.emitContinuity({ generation: 1, state: "restored" });
    const handle = await opening;
    expect(pendingConnection.pending()).toBeUndefined();
    f.emitContinuity({ generation: 2, state: "lost" });
    f.emitContinuity({ generation: 2, state: "restored" });
    expect(pendingConnection.pending()).toEqual({ type: "resync" });
    await handle.release();
  });

  it("reconciles unsubscribe rejection without retaining a ghost listener", async () => {
    const f = fixture();
    f.unsubscribe.mockImplementationOnce(async (workspaceId, listener) => {
      expect(f.listeners.get(workspaceId)).toBe(listener);
      f.listeners.delete(workspaceId);
      throw new Error("lost unsubscribe reply");
    });
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1, releaseGraceMs: 0 });
    const first = await gateway.attach(connection("one"));
    await expect(first.release()).rejects.toThrow("lost unsubscribe reply");
    expect(f.listeners.size).toBe(0);
    await expect(gateway.attach(connection("two"))).resolves.toMatchObject({ generation: 0 });
    expect(f.subscribe).toHaveBeenCalledTimes(2);
  });

  it("rejects a new unique workspace at capacity and recovers after token release", async () => {
    const f = fixture();
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1, releaseGraceMs: 0 });
    const first = await gateway.attach(connection("one", workspaceA));
    await expect(gateway.attach(connection("two", workspaceB))).rejects.toThrow(/capacity/i);
    await first.release();
    await expect(gateway.attach(connection("two", workspaceB))).resolves.toMatchObject({ generation: 0 });
  });

  it("cleans the exact subscription when shutdown closes a pending first subscribe", async () => {
    const ack = deferred<{ generation: number }>();
    const f = fixture();
    f.subscribe.mockImplementationOnce(async (workspaceId, listener) => {
      f.listeners.set(workspaceId, listener);
      return ack.promise;
    });
    const gateway = new WorkspaceGateway({ transport: f.transport, continuity: f.continuity, maxWorkspaces: 1 });
    const pendingSession = connection("one");
    const closeSpy = vi.spyOn(pendingSession, "requestClose");
    const opening = gateway.attach(pendingSession);
    await vi.waitFor(() => expect(f.subscribe).toHaveBeenCalledOnce());
    const closing = gateway.shutdown();
    ack.resolve({ generation: 0 });
    await expect(opening).rejects.toThrow();
    await closing;
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(closeSpy).toHaveBeenCalledWith("shutdown");
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    await expect(gateway.attach(connection("after-shutdown"))).rejects.toThrow(/shutdown|closed/i);
  });
});
