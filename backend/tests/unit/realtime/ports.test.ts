import { describe, expect, it, vi } from "vitest";
import { WorkspaceInterestRegistry } from "../../../src/modules/realtime/application/workspaceInterestRegistry.js";
import { RealtimeSession } from "../../../src/modules/realtime/domain/realtimeSession.js";

const workspaceId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

describe("realtime ports and state", () => {
  it("shares one dynamic workspace subscription and fans out through the workspace index", async () => {
    const subscribe = vi.fn(async (_workspaceId: string, _listener: unknown) => ({ generation: 0 }));
    const unsubscribe = vi.fn(async (_workspaceId: string, _listener: unknown) => undefined);
    const registry = new WorkspaceInterestRegistry({ transport: { subscribe, unsubscribe }, maxWorkspaces: 1 });
    const left = new RealtimeSession({ connectionId: "one", workspaceId });
    const right = new RealtimeSession({ connectionId: "two", workspaceId });
    await Promise.all([registry.add(left), registry.add(right)]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    const listener = subscribe.mock.calls[0]?.[1];
    registry.deliver(workspaceId, ["crawl.progress"]);
    expect(left.pending()).toEqual({ type: "invalidate", changeKinds: ["crawl.progress"] });
    expect(right.pending()).toEqual({ type: "invalidate", changeKinds: ["crawl.progress"] });
    await registry.remove(left);
    await registry.remove(left);
    await registry.remove(right);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledWith(workspaceId, listener);
  });

  it("releases failed single-flight subscription state so a later admission can retry", async () => {
    const subscribe = vi.fn()
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValueOnce({ generation: 0 });
    const registry = new WorkspaceInterestRegistry({ transport: { subscribe, unsubscribe: async () => undefined }, maxWorkspaces: 1 });
    const first = new RealtimeSession({ connectionId: "one", workspaceId });
    const second = new RealtimeSession({ connectionId: "two", workspaceId });
    await expect(Promise.all([registry.add(first), registry.add(second)])).rejects.toThrow(/broker unavailable/);
    await expect(registry.add(new RealtimeSession({ connectionId: "three", workspaceId }))).resolves.toEqual({ generation: 0 });
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("settles detach failure without retaining empty capacity and re-subscribes after churn", async () => {
    const listeners = new Set<unknown>();
    const subscribe = vi.fn(async (_workspaceId: string, listener: unknown) => { listeners.add(listener); return { generation: 0 }; });
    let unsubscribeCalls = 0;
    const unsubscribe = vi.fn(async (_workspaceId: string, listener: unknown) => {
      listeners.delete(listener);
      unsubscribeCalls += 1;
      if (unsubscribeCalls === 1) throw new Error("detach failed");
    });
    const registry = new WorkspaceInterestRegistry({ transport: { subscribe, unsubscribe }, maxWorkspaces: 1 });
    const first = new RealtimeSession({ connectionId: "one", workspaceId });
    await registry.add(first);
    expect(listeners.size).toBe(1);
    await expect(registry.remove(first)).rejects.toThrow(/detach failed/);
    expect(listeners.size).toBe(0);
    const next = new RealtimeSession({ connectionId: "two", workspaceId });
    await registry.add(next);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
    await registry.remove(next);
    expect(listeners.size).toBe(0);
    await registry.remove(next);
  });

  it("keeps a new session added while the first subscription is pending", async () => {
    const firstSubscribe = deferred<{ generation: number }>();
    const subscribe = vi.fn().mockImplementationOnce(() => firstSubscribe.promise);
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const registry = new WorkspaceInterestRegistry({ transport: { subscribe, unsubscribe }, maxWorkspaces: 1 });
    const first = new RealtimeSession({ connectionId: "one", workspaceId });
    const second = new RealtimeSession({ connectionId: "two", workspaceId });

    const firstAdd = registry.add(first);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    const remove = registry.remove(first);
    const secondAdd = registry.add(second);
    firstSubscribe.resolve({ generation: 0 });

    await Promise.all([firstAdd, remove, secondAdd]);
    registry.deliver(workspaceId, ["crawl.progress"]);
    expect(second.pending()).toEqual({ type: "invalidate", changeKinds: ["crawl.progress"] });
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("re-subscribes a session added while release is pending", async () => {
    const release = deferred();
    const subscribe = vi.fn().mockResolvedValue({ generation: 0 });
    const unsubscribe = vi.fn().mockImplementationOnce(() => release.promise);
    const registry = new WorkspaceInterestRegistry({ transport: { subscribe, unsubscribe }, maxWorkspaces: 1 });
    const first = new RealtimeSession({ connectionId: "one", workspaceId });
    const second = new RealtimeSession({ connectionId: "two", workspaceId });

    await registry.add(first);
    const remove = registry.remove(first);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    const add = registry.add(second);
    release.resolve();

    await Promise.all([remove, add]);
    expect(subscribe).toHaveBeenCalledTimes(2);
    registry.deliver(workspaceId, ["crawl.progress"]);
    expect(second.pending()).toEqual({ type: "invalidate", changeKinds: ["crawl.progress"] });
  });

  it("recovers an add during a failed release without orphaning either listener", async () => {
    const release = deferred();
    const listeners = new Set<unknown>();
    const subscribe = vi.fn(async (_workspaceId: string, listener: unknown) => { listeners.add(listener); return { generation: 0 }; });
    let unsubscribeCalls = 0;
    const unsubscribe = vi.fn(async (_workspaceId: string, listener: unknown) => {
      listeners.delete(listener);
      unsubscribeCalls += 1;
      if (unsubscribeCalls === 1) await release.promise;
    });
    const registry = new WorkspaceInterestRegistry({ transport: { subscribe, unsubscribe }, maxWorkspaces: 1 });
    const first = new RealtimeSession({ connectionId: "one", workspaceId });
    const second = new RealtimeSession({ connectionId: "two", workspaceId });

    await registry.add(first);
    const remove = registry.remove(first);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    expect(listeners.size).toBe(0);
    const add = registry.add(second);
    release.reject(new Error("lost unsubscribe reply"));

    await Promise.all([remove, add]);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
    await registry.remove(second);
    expect(listeners.size).toBe(0);
  });

  it("rejects every concurrent admission when their shared subscription fails", async () => {
    const subscribe = vi.fn().mockRejectedValue(new Error("broker unavailable"));
    const registry = new WorkspaceInterestRegistry({ transport: { subscribe, unsubscribe: vi.fn() }, maxWorkspaces: 1 });
    const results = await Promise.allSettled([
      registry.add(new RealtimeSession({ connectionId: "one", workspaceId })),
      registry.add(new RealtimeSession({ connectionId: "two", workspaceId })),
    ]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("keeps one dominant pending convergence state", () => {
    const session = new RealtimeSession({ connectionId: "one", workspaceId });
    session.mergeInvalidation(["crawl.progress"]);
    session.mergeInvalidation(["crawl.status_changed"]);
    session.requireResync();
    session.mergeInvalidation(["document.status_changed"]);
    expect(session.pending()).toEqual({ type: "resync" });
    expect(session.close()).toBe(true);
    expect(session.close()).toBe(false);
  });

  it("does not erase a marker merged while a prior frame is being written", () => {
    const session = new RealtimeSession({ connectionId: "one", workspaceId });
    session.mergeInvalidation(["crawl.progress"]);
    const writing = session.takePending();
    session.mergeInvalidation(["crawl.status_changed"]);
    expect(writing).toEqual({ type: "invalidate", changeKinds: ["crawl.progress"] });
    expect(session.pending()).toEqual({ type: "invalidate", changeKinds: ["crawl.status_changed"] });
    session.restorePending(writing);
    expect(session.takePending()).toEqual({ type: "invalidate", changeKinds: ["crawl.status_changed", "crawl.progress"] });
    session.requireResync();
    session.restorePending({ type: "invalidate", changeKinds: ["document.status_changed"] });
    expect(session.pending()).toEqual({ type: "resync" });
  });
});
