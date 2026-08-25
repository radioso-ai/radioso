import { describe, expect, it, vi } from "vitest";

import {
  WorkspaceGateway,
  type WorkspaceGatewayAttachment,
  type WorkspaceGatewayConnection,
} from "../../../src/modules/realtime/application/workspaceGateway.js";
import type { MonotonicClock } from "../../../src/modules/realtime/application/workspaceReleaseDeadlineScheduler.js";
import type {
  WorkspaceInterestContinuitySource,
  WorkspaceInterestTransport,
  WorkspaceInvalidationKind,
  WorkspaceInvalidationListener,
} from "../../../src/modules/realtime/domain/contracts.js";

const workspaceId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
type ProviderNeutralCloseReason = "superseded" | "shutdown" | "transport_lost";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
};

class TestClock implements MonotonicClock {
  private currentMs = 0;
  private readonly timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
  maxOutstanding = 0;

  now = (): number => this.currentMs;

  setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const token = {} as ReturnType<typeof setTimeout>;
    this.timers.set(token, { at: this.currentMs + Math.max(0, delayMs), callback });
    this.maxOutstanding = Math.max(this.maxOutstanding, this.timers.size);
    return token;
  };

  clearTimeout = (token: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(token);
  };

  advanceBy = (durationMs: number): void => {
    const target = this.currentMs + durationMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.currentMs = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.currentMs = target;
  };

  outstanding = (): number => this.timers.size;
}

const fixture = (maxWorkspaces = 1) => {
  const listeners = new Map<string, WorkspaceInvalidationListener>();
  const continuityListeners = new Set<(event: { generation: number; state: "lost" | "restored" }) => void>();
  const subscribe = vi.fn(async (id: string, listener: WorkspaceInvalidationListener) => {
    listeners.set(id, listener);
    return { generation: 1 };
  });
  const unsubscribe = vi.fn(async (id: string, listener: WorkspaceInvalidationListener): Promise<void> => {
    expect(listeners.get(id)).toBe(listener);
    listeners.delete(id);
  });
  const continuity: WorkspaceInterestContinuitySource = {
    onContinuity: (listener) => {
      continuityListeners.add(listener);
      return () => continuityListeners.delete(listener);
    },
  };
  const transport = { subscribe, unsubscribe } satisfies WorkspaceInterestTransport;
  const closeReasons: ProviderNeutralCloseReason[] = [];
  const connectionCloseReasons = new Map<string, ProviderNeutralCloseReason[]>();
  const connectionFor = (
    connectionId: string,
    connectionWorkspaceId = workspaceId,
    trackCloseReasons = true,
  ) => {
    const reasons: ProviderNeutralCloseReason[] = [];
    const connection = {
      connectionId,
      workspaceId: connectionWorkspaceId,
      enqueueInvalidation: vi.fn((_kinds: readonly WorkspaceInvalidationKind[]) => undefined),
      enqueueResync: vi.fn(),
      requestClose: vi.fn((reason: ProviderNeutralCloseReason) => {
        closeReasons.push(reason);
        reasons.push(reason);
      }),
    } satisfies WorkspaceGatewayConnection;
    if (trackCloseReasons) connectionCloseReasons.set(connectionId, reasons);
    return connection;
  };
  const connection = connectionFor("connection-1", workspaceId, maxWorkspaces === 1);
  const restorationFence = vi.fn();
  const clock = new TestClock();
  const input: ConstructorParameters<typeof WorkspaceGateway>[0] & { transportLossGraceMs: number } = {
    transport,
    continuity,
    maxWorkspaces,
    releaseGraceMs: 0,
    clock,
    transportLossGraceMs: 20_000,
  };
  return {
    gateway: new WorkspaceGateway(input),
    clock,
    transport,
    continuityListeners,
    connection,
    connectionFor,
    closeReasons,
    connectionCloseReasons,
    restorationFence,
    emitContinuity: (event: { generation: number; state: "lost" | "restored" }) => {
      if (event.state === "restored") restorationFence();
      for (const listener of continuityListeners) listener(event);
    },
  };
};

describe("WorkspaceGateway transport continuity RED contract", () => {
  it("exposes only accepted continuity transitions through a provider-neutral health port", async () => {
    const f = fixture();
    const health = vi.fn();
    const stop = f.gateway.onHealth(health);
    const attachment = await f.gateway.attach(f.connection);

    f.emitContinuity({ generation: 2, state: "lost" });
    f.emitContinuity({ generation: 1, state: "lost" });
    f.emitContinuity({ generation: 1, state: "restored" });
    f.emitContinuity({ generation: 2, state: "restored" });
    stop();
    f.emitContinuity({ generation: 3, state: "lost" });

    expect(health).toHaveBeenNthCalledWith(1, { state: "degraded" });
    expect(health).toHaveBeenNthCalledWith(2, { state: "restored" });
    expect(health).toHaveBeenCalledTimes(2);
    await attachment.release();
    await f.gateway.shutdown();
  });

  it("holds one resync during loss and restores interest before delivering it", async () => {
    const f = fixture();
    const attachment = await f.gateway.attach(f.connection);

    f.emitContinuity({ generation: 2, state: "lost" });
    expect(f.connection.enqueueResync).not.toHaveBeenCalled();

    f.emitContinuity({ generation: 2, state: "restored" });
    expect(f.restorationFence).toHaveBeenCalledOnce();
    expect(f.transport.subscribe).toHaveBeenCalledOnce();
    expect(f.connection.enqueueResync).toHaveBeenCalledOnce();
    expect(f.restorationFence.mock.invocationCallOrder[0]!)
      .toBeLessThan(f.connection.enqueueResync.mock.invocationCallOrder[0]!);

    await attachment.release();
    await f.gateway.shutdown();
    expect(f.clock.outstanding()).toBe(0);
  });

  it("ignores a mismatched restore and closes the affected connection once at the 20s monotonic deadline", async () => {
    const f = fixture();
    const attachment = await f.gateway.attach(f.connection);

    f.emitContinuity({ generation: 7, state: "lost" });
    f.emitContinuity({ generation: 8, state: "restored" });
    expect(f.connection.enqueueResync).not.toHaveBeenCalled();
    f.clock.advanceBy(19_999);
    expect(f.closeReasons.filter((reason) => reason === "transport_lost")).toHaveLength(0);
    f.clock.advanceBy(1);
    expect(f.closeReasons.filter((reason) => reason === "transport_lost")).toHaveLength(1);
    f.clock.advanceBy(20_000);
    expect(f.closeReasons.filter((reason) => reason === "transport_lost")).toHaveLength(1);

    await attachment.release();
    await f.gateway.shutdown();
    expect(f.clock.outstanding()).toBe(0);
  });

  it("cancels the transport-loss deadline when the matching generation restores", async () => {
    const f = fixture();
    const attachment = await f.gateway.attach(f.connection);

    f.emitContinuity({ generation: 9, state: "lost" });
    f.emitContinuity({ generation: 9, state: "restored" });
    f.clock.advanceBy(20_000);
    expect(f.closeReasons.filter((reason) => reason === "transport_lost")).toHaveLength(0);

    await attachment.release();
    await f.gateway.shutdown();
    expect(f.clock.outstanding()).toBe(0);
  });

  it("uses one indexed deadline for many workspace interests and closes every affected session once", async () => {
    const f = fixture(8);
    const attachments: WorkspaceGatewayAttachment[] = [];
    for (let workspaceIndex = 0; workspaceIndex < 8; workspaceIndex += 1) {
      for (let sessionIndex = 0; sessionIndex < 3; sessionIndex += 1) {
        const connection = f.connectionFor("connection-" + workspaceIndex + "-" + sessionIndex, "workspace-" + workspaceIndex);
        attachments.push(await f.gateway.attach(connection));
      }
    }
    expect(f.transport.subscribe).toHaveBeenCalledTimes(8);

    f.emitContinuity({ generation: 11, state: "lost" });
    expect.soft(f.clock.maxOutstanding).toBe(1);
    expect.soft(f.clock.outstanding()).toBe(1);
    f.clock.advanceBy(20_000);
    expect(f.closeReasons.filter((reason) => reason === "transport_lost")).toHaveLength(24);
    for (const reasons of f.connectionCloseReasons.values()) {
      expect(reasons.filter((reason) => reason === "transport_lost")).toHaveLength(1);
    }

    for (const attachment of attachments) await attachment.release();
    await f.gateway.shutdown();
    expect(f.clock.outstanding()).toBe(0);
  });

  it("cancels one shared loss deadline for many interests before the deadline and leaves no timer", async () => {
    const f = fixture(8);
    const attachments: WorkspaceGatewayAttachment[] = [];
    for (let workspaceIndex = 0; workspaceIndex < 8; workspaceIndex += 1) {
      const connection = f.connectionFor("connection-" + workspaceIndex, "workspace-" + workspaceIndex);
      attachments.push(await f.gateway.attach(connection));
    }

    f.emitContinuity({ generation: 12, state: "lost" });
    expect.soft(f.clock.maxOutstanding).toBe(1);
    expect.soft(f.clock.outstanding()).toBe(1);
    f.emitContinuity({ generation: 12, state: "restored" });
    f.clock.advanceBy(20_000);
    expect(f.closeReasons.filter((reason) => reason === "transport_lost")).toHaveLength(0);
    for (const attachment of attachments) await attachment.release();
    await f.gateway.shutdown();
    expect(f.clock.outstanding()).toBe(0);
  });
});
