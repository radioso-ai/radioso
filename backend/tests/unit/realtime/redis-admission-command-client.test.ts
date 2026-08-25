import { describe, expect, it, vi } from "vitest";

import { RedisAdmissionCommandClient } from "../../../src/modules/realtime/infrastructure/redisAdmissionCommandClient.js";

const redis = vi.hoisted(() => ({
  createClient: vi.fn(),
  createCluster: vi.fn(),
}));

vi.mock("redis", () => redis);

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

class TestClock {
  private nowMs = 0;
  private readonly timers = new Map<object, { at: number; callback: () => void }>();

  readonly setTimeout = vi.fn((callback: () => void, delayMs: number): object => {
    const token = {};
    this.timers.set(token, { at: this.nowMs + Math.max(0, delayMs), callback });
    return token;
  });

  readonly clearTimeout = vi.fn((token: object): void => {
    this.timers.delete(token);
  });

  advanceBy(durationMs: number): void {
    const target = this.nowMs + durationMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.nowMs = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.nowMs = target;
  }

  outstanding(): number {
    return this.timers.size;
  }
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

const clientFixture = () => {
  const connectGate = deferred<void>();
  const events = new Map<string, Set<() => void>>();
  const client = {
    connect: vi.fn(() => connectGate.promise),
    close: vi.fn(async (): Promise<void> => undefined),
    destroy: vi.fn(() => undefined),
    on: vi.fn((event: string, listener: () => void) => {
      const listeners = events.get(event) ?? new Set<() => void>();
      listeners.add(listener);
      events.set(event, listeners);
    }),
    withCommandOptions: vi.fn(() => ({ eval: vi.fn(async () => "PONG") })),
  };
  redis.createClient.mockReturnValue(client);
  return {
    client,
    connectGate,
    emit: (event: string) => {
      for (const listener of events.get(event) ?? []) listener();
    },
  };
};

const input = {
  mode: "standalone" as const,
  url: "redis://localhost:6379",
  seeds: [],
  tls: false,
  queuedCommands: 16,
  connectTimeoutMs: 100,
  commandTimeoutMs: 100,
};

const withClock = (clock: TestClock) => ({ ...input, clock });

describe("RedisAdmissionCommandClient startup RED contract", () => {
  it("aborts a pending connect before late settlement and leaves no deadline/listener or retry", async () => {
    const fixture = clientFixture();
    const clock = new TestClock();
    const commandClient = new RedisAdmissionCommandClient(withClock(clock));
    const startupSignal = new AbortController();
    const addAbortListener = vi.spyOn(startupSignal.signal, "addEventListener");
    const removeAbortListener = vi.spyOn(startupSignal.signal, "removeEventListener");
    const starting = commandClient.start(startupSignal.signal);
    await vi.waitFor(() => expect(fixture.client.connect).toHaveBeenCalledOnce());

    const startSettlement = starting.then(() => "started", () => "aborted");
    startupSignal.abort();
    const startOutcome = await startSettlement;
    expect(startOutcome).toBe("aborted");

    const closing = commandClient.close();
    const closeSettlement = closing.then(() => "closed", () => "failed");
    const closeOutcome = await closeSettlement;
    expect(closeOutcome).toBe("closed");
    expect(clock.outstanding()).toBe(0);
    expect(addAbortListener).toHaveBeenCalledOnce();
    expect(removeAbortListener).toHaveBeenCalledOnce();

    fixture.connectGate.resolve();
    await Promise.allSettled([starting, closing]);
    fixture.emit("ready");
    clock.advanceBy(input.connectTimeoutMs * 2);
    expect(fixture.client.destroy).toHaveBeenCalledOnce();
    expect(fixture.client.close).toHaveBeenCalledOnce();
    expect(fixture.client.connect).toHaveBeenCalledOnce();
    expect(clock.outstanding()).toBe(0);
    await expect(commandClient.start()).rejects.toThrow(/closed/i);
    expect(fixture.client.connect).toHaveBeenCalledOnce();
  });

  it("uses an injected deadline when connect never settles, destroys once, and fences late ready/retry", async () => {
    const fixture = clientFixture();
    const clock = new TestClock();
    const commandClient = new RedisAdmissionCommandClient(withClock(clock));
    const starting = commandClient.start();
    await vi.waitFor(() => expect(fixture.client.connect).toHaveBeenCalledOnce());

    const startSettlement = starting.then(() => "started", () => "timed-out");
    clock.advanceBy(input.connectTimeoutMs);
    const startOutcome = await startSettlement;
    expect(startOutcome).toBe("timed-out");
    expect(fixture.client.destroy).toHaveBeenCalledOnce();
    expect(clock.outstanding()).toBe(0);

    const closing = commandClient.close();
    const closeSettlement = closing.then(() => "closed", () => "failed");
    const closeOutcome = await closeSettlement;
    expect(closeOutcome).toBe("closed");
    expect(clock.outstanding()).toBe(0);

    fixture.connectGate.resolve();
    await Promise.allSettled([starting, closing]);
    clock.advanceBy(input.connectTimeoutMs * 2);
    expect(fixture.client.close).toHaveBeenCalledOnce();
    expect(fixture.client.destroy).toHaveBeenCalledTimes(1);
    expect(clock.outstanding()).toBe(0);
    fixture.emit("ready");
    await expect(commandClient.start()).rejects.toThrow(/closed/i);
    expect(fixture.client.connect).toHaveBeenCalledOnce();
  });

  it("rejects an already-aborted start without connecting and closes without retaining listeners", async () => {
    const fixture = clientFixture();
    const clock = new TestClock();
    const commandClient = new RedisAdmissionCommandClient(withClock(clock));
    const startupSignal = new AbortController();
    startupSignal.abort();
    const addAbortListener = vi.spyOn(startupSignal.signal, "addEventListener");
    const removeAbortListener = vi.spyOn(startupSignal.signal, "removeEventListener");

    const starting = commandClient.start(startupSignal.signal);
    const startSettlement = starting.then(() => "started", () => "aborted");
    const startOutcome = await startSettlement;
    expect(startOutcome).toBe("aborted");
    expect(fixture.client.connect).not.toHaveBeenCalled();
    expect(addAbortListener).not.toHaveBeenCalled();
    expect(removeAbortListener).not.toHaveBeenCalled();
    expect(clock.outstanding()).toBe(0);

    const closing = commandClient.close();
    const closeSettlement = closing.then(() => "closed", () => "failed");
    const closeOutcome = await closeSettlement;
    expect(closeOutcome).toBe("closed");
    expect(clock.outstanding()).toBe(0);
    fixture.connectGate.resolve();
    await Promise.allSettled([starting, closing]);
    clock.advanceBy(input.connectTimeoutMs * 2);
    expect(fixture.client.close).toHaveBeenCalledOnce();
    expect(fixture.client.destroy).not.toHaveBeenCalled();
    expect(clock.outstanding()).toBe(0);
  });

  it("closes directly while a connect is pending and fences its late completion", async () => {
    const fixture = clientFixture();
    const clock = new TestClock();
    const commandClient = new RedisAdmissionCommandClient(withClock(clock));
    const starting = commandClient.start();
    await vi.waitFor(() => expect(fixture.client.connect).toHaveBeenCalledOnce());

    const startSettlement = starting.then(() => "started", () => "aborted");
    const closing = commandClient.close();
    const closeSettlement = closing.then(() => "closed", () => "failed");
    const startOutcome = await startSettlement;
    expect(startOutcome).toBe("aborted");
    const closeOutcome = await closeSettlement;
    expect(closeOutcome).toBe("closed");
    expect(clock.outstanding()).toBe(0);
    fixture.connectGate.resolve();
    await Promise.allSettled([starting, closing]);
    clock.advanceBy(input.connectTimeoutMs * 2);
    expect(fixture.client.close).toHaveBeenCalledOnce();
    expect(fixture.client.destroy).not.toHaveBeenCalled();
    expect(clock.outstanding()).toBe(0);
    fixture.emit("ready");
    await expect(commandClient.start()).rejects.toThrow(/closed/i);
    expect(fixture.client.connect).toHaveBeenCalledOnce();
  });
});
