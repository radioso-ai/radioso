import { TRANSPORT_ENVELOPE_MAX_BYTES } from "@radioso/workspace-invalidation-contract";
import { describe, expect, it, vi } from "vitest";
import {
  createNodeRedisClientFactory,
  RedisInvalidationPublisher,
  RedisWorkspaceInterestSubscriber,
  type RedisLogicalClient,
  type RedisLogicalClientFactory,
} from "../../../src/modules/realtime/infrastructure/redisInvalidationTransport.js";

const nodeRedis = vi.hoisted(() => ({ createClient: vi.fn(), createCluster: vi.fn() }));
vi.mock("redis", () => nodeRedis);

const workspaceA = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
const workspaceB = "3e07ced1-9c3d-492a-b7cf-a885334df88d";
const channel = (workspaceId: string) => `test:workspace:{${workspaceId}}`;

class FakeRedisClient implements RedisLogicalClient {
  readonly events = new Map<string, Set<(...args: never[]) => void>>();
  readonly listeners = new Map<string, (payload: Uint8Array | string, channel: string) => void>();
  readonly publish = vi.fn(async () => 1);
  readonly sPublish = vi.fn(async () => 1);
  readonly subscribe = vi.fn(async (name: string, listener: (payload: Uint8Array | string, actualChannel: string) => void) => {
    this.listeners.set(name, listener);
  });
  readonly sSubscribe = vi.fn(async (name: string, listener: (payload: Uint8Array | string, actualChannel: string) => void) => {
    this.listeners.set(name, listener);
  });
  readonly unsubscribe = vi.fn(async (name: string) => { this.listeners.delete(name); });
  readonly sUnsubscribe = vi.fn(async (name: string) => { this.listeners.delete(name); });
  readonly connect = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly destroy = vi.fn(() => undefined);
  readonly withCommandOptions = vi.fn(() => this);

  on(event: "error" | "ready" | "reconnecting" | "end", listener: (...args: never[]) => void): void {
    const listeners = this.events.get(event) ?? new Set();
    listeners.add(listener);
    this.events.set(event, listeners);
  }

  emit(event: "error" | "ready" | "reconnecting" | "end"): void {
    for (const listener of this.events.get(event) ?? []) listener();
  }

  deliver(name: string, payload: Uint8Array | string): void {
    this.listeners.get(name)?.(payload, name);
  }
}

const clients = () => {
  const publisher = new FakeRedisClient();
  const subscriber = new FakeRedisClient();
  const factory = vi.fn<RedisLogicalClientFactory>((input) => input.role === "publisher" ? publisher : subscriber);
  return { factory, publisher, subscriber };
};

type DeferredVoid = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

const deferredVoid = (): DeferredVoid => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

const lifecycleClient = (input: { connectPending?: boolean; connectReject?: boolean; closePending?: boolean } = {}) => {
  const connectGate = deferredVoid();
  const closeGate = deferredVoid();
  const client = {
    connect: vi.fn(() => {
      if (input.connectReject) return Promise.reject(new Error("connect failed"));
      if (input.connectPending) return connectGate.promise;
      return Promise.resolve();
    }),
    close: vi.fn(() => input.closePending ? closeGate.promise : Promise.resolve()),
    destroy: vi.fn(() => {
      connectGate.resolve();
      closeGate.resolve();
    }),
    on: vi.fn(),
    publish: vi.fn(async () => 1),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    withCommandOptions: vi.fn(() => client),
  };
  const factory = vi.fn<RedisLogicalClientFactory>(() => client as unknown as RedisLogicalClient);
  return { client, factory, connectGate, closeGate };
};

const bounded = async <T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const boundedSettlement = async (promise: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const envelope = (workspaceId = workspaceA) => JSON.stringify({
  protocolVersion: 1,
  workspaceId,
  changeKinds: ["crawl.status_changed"],
});

describe("RedisInvalidationTransport", () => {
  it("exports role-scoped public adapters without a combined event-bus surface", () => {
    const publisher = new RedisInvalidationPublisher({ channelPrefix: "test", commandTimeoutMs: 100, createClient: clients().factory, mode: "standalone" });
    const subscriber = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: clients().factory, mode: "standalone" });

    expect("subscribe" in publisher).toBe(false);
    expect("unsubscribe" in publisher).toBe(false);
    expect("start" in publisher).toBe(false);
    expect("onContinuity" in publisher).toBe(false);
    expect("publish" in subscriber).toBe(false);
  });

  it("starts a zero-interest subscriber exactly once so gateway readiness has an explicit lifecycle", async () => {
    const fake = clients();
    const telemetry = { event: vi.fn() };
    const subscriber = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "standalone", telemetry });

    await Promise.all([subscriber.start(), subscriber.start()]);
    await subscriber.close();
    await subscriber.close();

    expect(fake.factory).toHaveBeenCalledOnce();
    expect(fake.factory).toHaveBeenCalledWith(expect.objectContaining({ role: "subscriber" }));
    expect(fake.subscriber.connect).toHaveBeenCalledOnce();
    expect(fake.publisher.connect).not.toHaveBeenCalled();
    expect(fake.subscriber.close).toHaveBeenCalledOnce();
    expect(telemetry.event.mock.calls.filter(([outcome]) => outcome === "failed")).toHaveLength(0);
  });

  it("maps standalone and cluster node-redis options locally, including fresh IAM credentials under cluster defaults", async () => {
    nodeRedis.createClient.mockReturnValue({});
    nodeRedis.createCluster.mockReturnValue({});
    const iam = vi.fn(async () => ({ password: "token" }));
    const factory = createNodeRedisClientFactory({
      connectTimeoutMs: 123,
      credentialsProvider: iam,
      queuedCommands: 7,
      seeds: ["rediss://one:6379", "rediss://two:6379"],
      tls: true,
      url: "redis://standalone:6379",
    });

    factory({ commandTimeoutMs: 100, credentialsProvider: iam, disableOfflineQueue: true, mode: "standalone", role: "publisher" });
    factory({ commandTimeoutMs: 100, credentialsProvider: iam, disableOfflineQueue: true, mode: "redis-cluster", role: "subscriber" });

    expect(nodeRedis.createClient).toHaveBeenCalledWith(expect.objectContaining({
      commandsQueueMaxLength: 7,
      disableOfflineQueue: true,
      socket: { connectTimeout: 123, tls: true },
      url: "redis://standalone:6379",
    }));
    expect(nodeRedis.createCluster).toHaveBeenCalledWith(expect.objectContaining({
      commandOptions: { timeout: 100 },
      defaults: expect.objectContaining({ commandsQueueMaxLength: 7, disableOfflineQueue: true, socket: { connectTimeout: 123, tls: true } }),
      minimizeConnections: true,
      rootNodes: [{ url: "rediss://one:6379" }, { url: "rediss://two:6379" }],
    }));
    const provider = nodeRedis.createCluster.mock.calls[0]?.[0].defaults.credentialsProvider;
    await expect(provider.credentials()).resolves.toEqual({ password: "token", username: "default" });
    await expect(provider.credentials()).resolves.toEqual({ password: "token", username: "default" });
    expect(iam).toHaveBeenCalledTimes(2);
  });

  it("normalizes Buffer channel names from node-redis while preserving Buffer payloads in standalone and sharded callbacks", async () => {
    let standaloneMessage: ((payload: string | Buffer, actualChannel: string | Buffer) => void) | undefined;
    let clusterMessage: ((payload: string | Buffer, actualChannel: string | Buffer) => void) | undefined;
    const standalone = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      on: vi.fn(),
      publish: vi.fn(async () => 1),
      subscribe: vi.fn(async (_name: string, listener: (payload: string | Buffer, actualChannel: string | Buffer) => void) => { standaloneMessage = listener; }),
      unsubscribe: vi.fn(async () => undefined),
      withCommandOptions: vi.fn(() => standalone),
    };
    const cluster = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      on: vi.fn(),
      sPublish: vi.fn(async () => 1),
      sSubscribe: vi.fn(async (_name: string, listener: (payload: string | Buffer, actualChannel: string | Buffer) => void) => { clusterMessage = listener; }),
      sUnsubscribe: vi.fn(async () => undefined),
      withCommandOptions: vi.fn(() => cluster),
    };
    nodeRedis.createClient.mockReturnValue(standalone);
    nodeRedis.createCluster.mockReturnValue(cluster);
    const factory = createNodeRedisClientFactory({ connectTimeoutMs: 100, queuedCommands: 4, seeds: ["redis://localhost:6379"], tls: false });
    const standaloneLogical = factory({ commandTimeoutMs: 100, disableOfflineQueue: true, mode: "standalone", role: "subscriber" });
    const clusterLogical = factory({ commandTimeoutMs: 100, disableOfflineQueue: true, mode: "redis-cluster", role: "subscriber" });
    const standaloneListener = vi.fn();
    const clusterListener = vi.fn();
    await standaloneLogical.connect();
    await clusterLogical.connect();
    await standaloneLogical.subscribe?.(channel(workspaceA), standaloneListener);
    const standaloneWrapper = standalone.subscribe.mock.calls[0]?.[1];
    await standaloneLogical.subscribe?.(channel(workspaceA), standaloneListener);
    const repeatedStandaloneWrapper = standalone.subscribe.mock.calls[1]?.[1];
    await clusterLogical.sSubscribe?.(channel(workspaceA), clusterListener);
    const clusterWrapper = cluster.sSubscribe.mock.calls[0]?.[1];
    await clusterLogical.sSubscribe?.(channel(workspaceA), clusterListener);
    const repeatedClusterWrapper = cluster.sSubscribe.mock.calls[1]?.[1];

    expect(repeatedStandaloneWrapper).toBe(standaloneWrapper);
    expect(repeatedClusterWrapper).toBe(clusterWrapper);

    const payload = Buffer.from(envelope());
    standaloneWrapper?.(payload, Buffer.from(channel(workspaceA)));
    clusterWrapper?.(payload, Buffer.from(channel(workspaceA)));
    expect(() => standaloneMessage?.(payload, Buffer.from([0xc3, 0x28]))).not.toThrow();

    expect(standaloneListener).toHaveBeenCalledWith(payload, channel(workspaceA));
    expect(clusterListener).toHaveBeenCalledWith(payload, channel(workspaceA));
    expect(standaloneListener).toHaveBeenCalledTimes(1);
    expect(clusterListener).toHaveBeenCalledTimes(1);
    standaloneMessage?.(payload, Buffer.from([0xff]));
    clusterMessage?.(payload, Buffer.from([0xff]));
    expect(standaloneListener).toHaveBeenCalledTimes(1);
    expect(clusterListener).toHaveBeenCalledTimes(1);
  });

  it("bounds a graceful close when the provider close never settles, then destroys exactly once", async () => {
    const fixture = lifecycleClient({ closePending: true });
    const telemetry = { event: vi.fn() };
    const publisher = new RedisInvalidationPublisher({ channelPrefix: "test", commandTimeoutMs: 50, createClient: fixture.factory, mode: "standalone", telemetry });
    await publisher.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: ["crawl.status_changed"] }, { signal: new AbortController().signal });

    const closing = publisher.close();
    expect(publisher.close()).toBe(closing);
    expect(await bounded(closing, 250)).toBe(true);
    expect(fixture.client.destroy).toHaveBeenCalledOnce();
    expect(fixture.client.close).toHaveBeenCalledOnce();
    expect(telemetry.event.mock.calls.filter(([outcome]) => outcome === "failed")).toHaveLength(1);
    fixture.closeGate.resolve();
    await Promise.allSettled([closing]);
  });

  it("bounds close before pending subscriber connect settles and fences a late resolution", async () => {
    const fixture = lifecycleClient({ connectPending: true, closePending: true });
    const subscriber = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 50, createClient: fixture.factory, mode: "standalone" });
    const starting = subscriber.start();
    await vi.waitFor(() => expect(fixture.client.connect).toHaveBeenCalledOnce());

    const closing = subscriber.close();
    expect(await bounded(closing, 250)).toBe(true);
    expect(fixture.client.destroy).toHaveBeenCalledOnce();
    fixture.connectGate.resolve();
    fixture.closeGate.resolve();
    await Promise.allSettled([starting, closing]);
    await expect(subscriber.close()).resolves.toBeUndefined();
    expect(fixture.client.destroy).toHaveBeenCalledOnce();
  });

  it("bounds failed-open cleanup when provider close never settles", async () => {
    const fixture = lifecycleClient({ connectReject: true, closePending: true });
    const telemetry = { event: vi.fn() };
    const subscriber = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 50, createClient: fixture.factory, mode: "standalone", telemetry });
    const starting = subscriber.start();

    expect(await boundedSettlement(starting, 250)).toBe(true);
    await expect(starting).rejects.toThrow("connect failed");
    expect(fixture.client.destroy).toHaveBeenCalledOnce();
    expect(telemetry.event.mock.calls.filter(([outcome]) => outcome === "failed")).toHaveLength(1);
    fixture.closeGate.resolve();
    await Promise.allSettled([starting, subscriber.close()]);
  });

  it("destroys each provider generation independently after failed start and retry", async () => {
    const first = lifecycleClient({ connectReject: true, closePending: true });
    const second = lifecycleClient({ closePending: true });
    const generations = [first, second];
    let generationIndex = 0;
    const factory = vi.fn<RedisLogicalClientFactory>(() => {
      const generation = generations[generationIndex++];
      if (!generation) throw new Error("unexpected Redis client generation");
      return generation.client as unknown as RedisLogicalClient;
    });
    const subscriber = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 50, createClient: factory, mode: "standalone" });

    const firstStarting = subscriber.start();
    expect(await boundedSettlement(firstStarting, 250)).toBe(true);
    await expect(firstStarting).rejects.toThrow("connect failed");
    expect(first.client.close).toHaveBeenCalledOnce();
    expect(first.client.destroy).toHaveBeenCalledOnce();

    await expect(subscriber.start()).resolves.toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(2);

    const closing = subscriber.close();
    expect(subscriber.close()).toBe(closing);
    expect(await bounded(closing, 250)).toBe(true);
    expect(second.client.close).toHaveBeenCalledOnce();
    expect(first.client.destroy).toHaveBeenCalledOnce();
    expect(second.client.destroy).toHaveBeenCalledOnce();

    first.closeGate.resolve();
    second.closeGate.resolve();
    await Promise.allSettled([firstStarting, closing]);
    expect(first.client.destroy).toHaveBeenCalledOnce();
    expect(second.client.destroy).toHaveBeenCalledOnce();
  });

  it("uses two independent standalone logical clients with PUBLISH/SUBSCRIBE and error listeners", async () => {
    const fake = clients();
    const publisher = new RedisInvalidationPublisher({
      channelPrefix: "test",
      commandTimeoutMs: 100,
      createClient: fake.factory,
      mode: "standalone",
    });
    const subscriber = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "standalone" });
    const listener = vi.fn();

    await subscriber.subscribe(workspaceA, listener);
    await publisher.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: ["crawl.status_changed"] }, { signal: new AbortController().signal });

    expect(fake.factory).toHaveBeenCalledTimes(2);
    expect(fake.factory.mock.calls.map(([input]) => input.role).sort()).toEqual(["publisher", "subscriber"]);
    expect(fake.publisher.publish).toHaveBeenCalledWith(channel(workspaceA), envelope());
    expect(fake.publisher.withCommandOptions).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: expect.any(AbortSignal), timeout: 100 }));
    expect(fake.subscriber.subscribe).toHaveBeenCalledWith(channel(workspaceA), expect.any(Function));
    expect(fake.publisher.events.get("error")?.size).toBe(1);
    expect(fake.subscriber.events.get("error")?.size).toBe(1);
    fake.subscriber.deliver(channel(workspaceA), Buffer.from(envelope()));
    expect(listener).toHaveBeenCalledWith(["crawl.status_changed"]);
  });

  it("uses one-channel sharded Pub/Sub commands in cluster mode and passes IAM credentials to both clients", async () => {
    const fake = clients();
    const credentialsProvider = vi.fn(async () => ({ password: "fresh-token" }));
    const publisher = new RedisInvalidationPublisher({
      channelPrefix: "test",
      commandTimeoutMs: 100,
      createClient: fake.factory,
      credentialsProvider,
      mode: "redis-cluster",
    });
    const subscriber = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, credentialsProvider, mode: "redis-cluster" });
    const listener = vi.fn();

    await subscriber.subscribe(workspaceA, listener);
    await subscriber.unsubscribe(workspaceA, listener);
    await publisher.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: ["crawl.status_changed"] }, { signal: new AbortController().signal });

    expect(fake.subscriber.sSubscribe).toHaveBeenCalledWith(channel(workspaceA), expect.any(Function));
    expect(fake.subscriber.sUnsubscribe).toHaveBeenCalledWith(channel(workspaceA));
    expect(fake.publisher.sPublish).toHaveBeenCalledWith(channel(workspaceA), envelope());
    expect(fake.publisher.publish).not.toHaveBeenCalled();
    expect(fake.factory.mock.calls.map(([input]) => input.credentialsProvider)).toEqual([credentialsProvider, credentialsProvider]);
  });

  it("parses bytes before decode, validates the actual channel and workspace scope, and preserves duplicate delivery", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "standalone" });
    const listener = vi.fn();
    await transport.subscribe(workspaceA, listener);

    fake.subscriber.deliver(channel(workspaceA), new TextEncoder().encode("😀".repeat(TRANSPORT_ENVELOPE_MAX_BYTES)));
    fake.subscriber.listeners.get(channel(workspaceA))?.(Buffer.from(envelope()), channel(workspaceB));
    fake.subscriber.deliver(channel(workspaceA), Buffer.from(envelope(workspaceB)));
    fake.subscriber.deliver(channel(workspaceA), new Uint8Array([0xc3, 0x28]));
    fake.subscriber.deliver(channel(workspaceA), Buffer.from("not-json"));
    fake.subscriber.deliver(channel(workspaceA), Buffer.from(envelope()));
    fake.subscriber.deliver(channel(workspaceA), Buffer.from(envelope()));

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, ["crawl.status_changed"]);
  });

  it("transactionally removes a listener rejected before ready so it cannot become a ghost interest", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "standalone" });
    await transport.start();
    const rejected = vi.fn();
    fake.subscriber.emit("error");

    await expect(transport.subscribe(workspaceA, rejected)).rejects.toThrow("continuity is unavailable");
    fake.subscriber.emit("ready");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.subscriber.subscribe).not.toHaveBeenCalled();

    const admitted = vi.fn();
    await transport.subscribe(workspaceA, admitted);
    fake.subscriber.deliver(channel(workspaceA), Buffer.from(envelope()));
    expect(rejected).not.toHaveBeenCalled();
    expect(admitted).toHaveBeenCalledOnce();
  });

  it("retains uncertain remote state until acknowledged, caps it with workspace interests, and later cleans it before subscribing", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({
      channelPrefix: "test",
      commandTimeoutMs: 100,
      createClient: fake.factory,
      maxWorkspaceInterests: 1,
      mode: "standalone",
    });
    const listener = vi.fn();
    await transport.subscribe(workspaceA, listener);
    fake.subscriber.unsubscribe.mockRejectedValueOnce(new Error("unconfirmed"));
    await expect(transport.unsubscribe(workspaceA, listener)).rejects.toThrow("unconfirmed");

    await expect(transport.subscribe(workspaceB, vi.fn())).rejects.toThrow("interest capacity");
    await transport.subscribe(workspaceA, listener);
    expect(fake.subscriber.unsubscribe).toHaveBeenCalledTimes(2);
    expect(fake.subscriber.subscribe).toHaveBeenCalledTimes(2);
  });

  it("cancels the healthy-socket uncertainty retry timer on close", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({
      channelPrefix: "test",
      commandTimeoutMs: 100,
      createClient: fake.factory,
      mode: "standalone",
      restoreRetryBaseMs: 25,
      restoreRetryMaxMs: 25,
    });
    const listener = vi.fn();
    await transport.subscribe(workspaceA, listener);
    fake.subscriber.unsubscribe.mockRejectedValue(new Error("still uncertain"));
    await expect(transport.unsubscribe(workspaceA, listener)).rejects.toThrow("still uncertain");

    await vi.waitFor(() => expect(fake.subscriber.unsubscribe.mock.calls.length).toBeGreaterThanOrEqual(2));
    const attemptsBeforeClose = fake.subscriber.unsubscribe.mock.calls.length;
    await transport.close();
    const attemptsAtClose = fake.subscriber.unsubscribe.mock.calls.length;
    expect(attemptsAtClose).toBeGreaterThanOrEqual(attemptsBeforeClose);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.subscriber.unsubscribe.mock.calls.length).toBe(attemptsAtClose);
  });

  it("autonomously heals healthy-socket uncertainty and releases capped interest capacity without a Redis event", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({
      channelPrefix: "test",
      commandTimeoutMs: 100,
      createClient: fake.factory,
      maxWorkspaceInterests: 1,
      mode: "standalone",
      restoreRetryBaseMs: 1,
      restoreRetryMaxMs: 2,
    });
    const listener = vi.fn();
    await transport.subscribe(workspaceA, listener);
    fake.subscriber.unsubscribe
      .mockRejectedValueOnce(new Error("initial uncertain"))
      .mockRejectedValueOnce(new Error("retry one"))
      .mockRejectedValueOnce(new Error("retry two"))
      .mockResolvedValueOnce(undefined);

    await expect(transport.unsubscribe(workspaceA, listener)).rejects.toThrow("initial uncertain");
    await vi.waitFor(() => expect(fake.subscriber.unsubscribe).toHaveBeenCalledTimes(4));
    await expect(transport.subscribe(workspaceB, vi.fn())).resolves.toEqual({ generation: 0 });
  });

  it("keeps retrying uncertain cleanup until a later acknowledgement restores the same generation", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({
      channelPrefix: "test",
      commandTimeoutMs: 100,
      createClient: fake.factory,
      mode: "standalone",
      restoreRetryBaseMs: 1,
      restoreRetryMaxMs: 2,
    });
    const listener = vi.fn();
    await transport.subscribe(workspaceA, listener);
    fake.subscriber.unsubscribe.mockRejectedValueOnce(new Error("initial uncertain"));
    await expect(transport.unsubscribe(workspaceA, listener)).rejects.toThrow("initial uncertain");
    fake.subscriber.unsubscribe
      .mockRejectedValueOnce(new Error("retry one"))
      .mockRejectedValueOnce(new Error("retry two"))
      .mockResolvedValueOnce(undefined);
    const continuity = vi.fn();
    transport.onContinuity(continuity);

    fake.subscriber.emit("error");
    fake.subscriber.emit("ready");
    await vi.waitFor(() => expect(fake.subscriber.unsubscribe).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(continuity).toHaveBeenCalledWith({ generation: 1, state: "restored" }));
    await transport.subscribe(workspaceB, vi.fn());
  });

  it("keeps sibling listeners during local churn and cleans partially-started clients after connect failure", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "standalone" });
    const left = vi.fn();
    const right = vi.fn();
    await transport.subscribe(workspaceA, left);
    await transport.subscribe(workspaceA, right);
    await transport.unsubscribe(workspaceA, left);
    fake.subscriber.deliver(channel(workspaceA), Buffer.from(envelope()));
    expect(left).not.toHaveBeenCalled();
    expect(right).toHaveBeenCalledOnce();
    expect(fake.subscriber.unsubscribe).not.toHaveBeenCalled();

    const partial = clients();
    partial.subscriber.connect.mockRejectedValueOnce(new Error("connect failed"));
    const failing = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: partial.factory, mode: "standalone" });
    await expect(failing.subscribe(workspaceB, vi.fn())).rejects.toThrow("connect failed");
    expect(partial.subscriber.close).toHaveBeenCalledOnce();
  });

  it("detaches the exact listener before failed broker unsubscribe and heals through a later generation", async () => {
    const fake = clients();
    fake.subscriber.unsubscribe.mockRejectedValueOnce(new Error("lost reply"));
    const transport = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "standalone" });
    const listener = vi.fn();
    await transport.subscribe(workspaceA, listener);
    await expect(transport.unsubscribe(workspaceA, listener)).rejects.toThrow("lost reply");
    fake.subscriber.deliver(channel(workspaceA), Buffer.from(envelope()));
    expect(listener).not.toHaveBeenCalled();

    fake.subscriber.emit("error");
    fake.subscriber.emit("ready");
    await vi.waitFor(() => expect(fake.subscriber.unsubscribe).toHaveBeenCalledTimes(2));
    await transport.subscribe(workspaceA, listener);
    fake.subscriber.deliver(channel(workspaceA), Buffer.from(envelope()));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("bounds commands with abort/timeout and never relies on an offline publisher queue", async () => {
    const fake = clients();
    const never = new Promise<number>(() => undefined);
    fake.publisher.publish.mockReturnValueOnce(never);
    const transport = new RedisInvalidationPublisher({ channelPrefix: "test", commandTimeoutMs: 10, createClient: fake.factory, mode: "standalone" });
    const controller = new AbortController();
    const publish = transport.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: ["crawl.status_changed"] }, { signal: controller.signal });
    controller.abort();
    await expect(publish).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.factory.mock.calls[0]?.[0]).toMatchObject({ disableOfflineQueue: true });
  });

  it("coalesces loss, restores all current interests before one fenced restored generation, and shuts down idempotently", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "redis-cluster" });
    await transport.subscribe(workspaceA, vi.fn());
    await transport.subscribe(workspaceB, vi.fn());
    const continuity = vi.fn();
    const stop = transport.onContinuity(continuity);

    fake.subscriber.emit("error");
    fake.subscriber.emit("reconnecting");
    fake.subscriber.emit("ready");
    await vi.waitFor(() => expect(fake.subscriber.sSubscribe).toHaveBeenCalledTimes(4));

    expect(continuity).toHaveBeenCalledWith({ generation: 1, state: "lost" });
    expect(continuity).toHaveBeenCalledWith({ generation: 1, state: "restored" });
    expect(fake.subscriber.sSubscribe.mock.invocationCallOrder[2]).toBeLessThan(fake.subscriber.sSubscribe.mock.invocationCallOrder[3]!);
    stop();
    await Promise.all([transport.close(), transport.close()]);
    expect(fake.subscriber.close).toHaveBeenCalledTimes(1);
  });

  it("waits for a workspace added at a restore pass boundary before announcing restored", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "standalone" });
    await transport.subscribe(workspaceA, vi.fn());
    const continuity = vi.fn();
    transport.onContinuity(continuity);

    let acknowledgeWorkspaceB: (() => void) | undefined;
    const workspaceBSubscribed = new Promise<void>((resolve) => { acknowledgeWorkspaceB = resolve; });
    const subscribe = fake.subscriber.subscribe.getMockImplementation()!;
    fake.subscriber.subscribe
      .mockImplementationOnce(async () => {
        void transport.subscribe(workspaceB, vi.fn());
      })
      .mockImplementationOnce(async () => workspaceBSubscribed)
      .mockImplementation(subscribe);

    fake.subscriber.emit("error");
    fake.subscriber.emit("ready");
    await vi.waitFor(() => expect(fake.subscriber.subscribe).toHaveBeenCalledTimes(3));
    expect(continuity).not.toHaveBeenCalledWith({ generation: 1, state: "restored" });

    acknowledgeWorkspaceB?.();
    await vi.waitFor(() => expect(continuity).toHaveBeenCalledWith({ generation: 1, state: "restored" }));
  });

  it("emits only low-cardinality transport outcomes for connection, recovery, restore failure, and publisher runtime error", async () => {
    const fake = clients();
    const events: string[] = [];
    const telemetry = { event: (outcome: "connected" | "reconnect" | "failed") => events.push(outcome) };
    const subscriber = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "standalone", telemetry });
    await subscriber.subscribe(workspaceA, vi.fn());
    const subscribe = fake.subscriber.subscribe.getMockImplementation()!;
    fake.subscriber.subscribe.mockImplementationOnce(async () => { throw new Error("retryable"); }).mockImplementation(subscribe);
    fake.subscriber.emit("error");
    fake.subscriber.emit("reconnecting");
    fake.subscriber.emit("ready");
    await vi.waitFor(() => expect(events).toEqual(["connected", "reconnect", "failed", "connected"]));

    const publisher = new RedisInvalidationPublisher({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "standalone", telemetry });
    await publisher.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: ["crawl.status_changed"] }, { signal: new AbortController().signal });
    fake.publisher.emit("error");
    expect(events).toEqual(["connected", "reconnect", "failed", "connected", "connected", "failed"]);
    expect(events.every((outcome) => ["connected", "reconnect", "failed"].includes(outcome))).toBe(true);
  });

  it("retries one failed restore while the socket remains ready, then restores the current generation", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "redis-cluster" });
    await transport.subscribe(workspaceA, vi.fn());
    const continuity = vi.fn();
    transport.onContinuity(continuity);
    const subscribe = fake.subscriber.sSubscribe.getMockImplementation()!;
    fake.subscriber.sSubscribe.mockImplementationOnce(async () => { throw new Error("slot moving"); }).mockImplementation(subscribe);
    fake.subscriber.emit("error");
    fake.subscriber.emit("ready");
    await vi.waitFor(() => expect(fake.subscriber.sSubscribe).toHaveBeenCalledTimes(3));
    expect(continuity).toHaveBeenCalledWith({ generation: 1, state: "lost" });
    await vi.waitFor(() => expect(continuity).toHaveBeenCalledWith({ generation: 1, state: "restored" }));
  });

  it("fences an in-flight restore when a second loss arrives before its subscribe acknowledgement", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "redis-cluster" });
    await transport.subscribe(workspaceA, vi.fn());
    const continuity = vi.fn();
    transport.onContinuity(continuity);

    let acknowledgeRestore: (() => void) | undefined;
    const restoreAcknowledged = new Promise<void>((resolve) => { acknowledgeRestore = resolve; });
    const subscribe = fake.subscriber.sSubscribe.getMockImplementation()!;
    fake.subscriber.sSubscribe.mockImplementationOnce(async () => restoreAcknowledged).mockImplementation(subscribe);
    fake.subscriber.emit("error");
    fake.subscriber.emit("ready");
    await vi.waitFor(() => expect(fake.subscriber.sSubscribe).toHaveBeenCalledTimes(2));

    fake.subscriber.emit("error");
    acknowledgeRestore?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(continuity).toHaveBeenCalledWith({ generation: 1, state: "lost" });
    expect(continuity).not.toHaveBeenCalledWith({ generation: 1, state: "restored" });

    fake.subscriber.emit("ready");
    await vi.waitFor(() => expect(continuity).toHaveBeenCalledWith({ generation: 1, state: "restored" }));
  });

  it("does not resolve new subscription readiness while the current generation is restoring", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "standalone" });
    await transport.subscribe(workspaceA, vi.fn());

    let acknowledgeRestore: (() => void) | undefined;
    const restoreAcknowledged = new Promise<void>((resolve) => { acknowledgeRestore = resolve; });
    const subscribe = fake.subscriber.subscribe.getMockImplementation()!;
    fake.subscriber.subscribe.mockImplementationOnce(async () => restoreAcknowledged).mockImplementation(subscribe);
    fake.subscriber.emit("error");
    fake.subscriber.emit("ready");
    await vi.waitFor(() => expect(fake.subscriber.subscribe).toHaveBeenCalledTimes(2));

    const subscription = transport.subscribe(workspaceB, vi.fn());
    let settled = false;
    void subscription.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledgeRestore?.();
    await expect(subscription).resolves.toEqual({ generation: 1 });
  });

  it("re-evaluates desired listeners after a delayed restore acknowledgement", async () => {
    const fake = clients();
    const transport = new RedisWorkspaceInterestSubscriber({ channelPrefix: "test", commandTimeoutMs: 100, createClient: fake.factory, mode: "standalone" });
    const left = vi.fn();
    const right = vi.fn();
    await transport.subscribe(workspaceA, left);

    let acknowledgeRestore: (() => void) | undefined;
    const restoreAcknowledged = new Promise<void>((resolve) => { acknowledgeRestore = resolve; });
    const subscribe = fake.subscriber.subscribe.getMockImplementation()!;
    fake.subscriber.subscribe.mockImplementationOnce(async () => restoreAcknowledged).mockImplementation(subscribe);

    fake.subscriber.emit("error");
    fake.subscriber.emit("ready");
    await vi.waitFor(() => expect(fake.subscriber.subscribe).toHaveBeenCalledTimes(2));

    const remove = transport.unsubscribe(workspaceA, left);
    const add = transport.subscribe(workspaceA, right);
    acknowledgeRestore?.();
    await Promise.all([remove, add]);

    fake.subscriber.deliver(channel(workspaceA), Buffer.from(envelope()));
    expect(left).not.toHaveBeenCalled();
    expect(right).toHaveBeenCalledOnce();
    expect(fake.subscriber.subscribe).toHaveBeenCalledTimes(2);
  });
});
