import net from "node:net";
import { randomUUID } from "node:crypto";

import { describe, expect, it, beforeAll, afterEach } from "vitest";
import type { WorkspaceInvalidationKind } from "@radioso/workspace-invalidation-contract";
import {
  RedisAdmissionCommandClient,
} from "../../../src/modules/realtime/infrastructure/redisAdmissionCommandClient.js";
import { RedisAdmissionController, RealtimeAdmissionError } from "../../../src/modules/realtime/infrastructure/redisAdmissionController.js";
import {
  createNodeRedisClientFactory,
  RedisInvalidationPublisher,
  RedisWorkspaceInterestSubscriber,
  type RedisLogicalClientFactory,
} from "../../../src/modules/realtime/infrastructure/redisInvalidationTransport.js";
import {
  WorkspaceGateway,
  type WorkspaceGatewayConnection,
} from "../../../src/modules/realtime/application/workspaceGateway.js";
import {
  SsePresenter,
  type SsePresenterLimits,
  type SseResponse,
  type SseStreamTelemetry,
} from "../../../src/modules/realtime/http/ssePresenter.js";
import type {
  RealtimeAdmissionLease,
} from "../../../src/modules/realtime/domain/contracts.js";
import { RedisFaultProxy } from "../../support/realtime/redisFaultProxy.js";

const configuredRedisUrl = process.env.REALTIME_INTEGRATION_REDIS_URL;
const redisIntegration = configuredRedisUrl ? describe : describe.skip;
const workspaceA = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
const workspaceB = "3e07ced1-9c3d-492a-b7cf-a885334df88d";
const accountA = "account-t063-a";
const principalA = "principal-t063-a";

type ResponseEvent = "close" | "drain" | "error" | "finish";

class IntegrationResponse implements SseResponse {
  committed = false;
  readonly frames: string[] = [];
  endCount = 0;
  destroyCount = 0;
  destroyedWith: unknown[] = [];
  writableLength = 0;
  private readonly listeners = new Map<ResponseEvent, Set<() => void>>();

  commitSse(): void {
    this.committed = true;
  }

  write(frame: Uint8Array): boolean {
    if (!this.committed) throw new Error("SSE write before commit");
    this.frames.push(new TextDecoder().decode(frame));
    return true;
  }

  end(): void {
    this.endCount += 1;
  }

  destroy(error?: unknown): void {
    this.destroyCount += 1;
    this.destroyedWith.push(error);
  }

  on(event: ResponseEvent, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: ResponseEvent, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: ResponseEvent): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  listenerCount(event?: ResponseEvent): number {
    if (event) return this.listeners.get(event)?.size ?? 0;
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

class FixedCardTelemetry implements SseStreamTelemetry {
  readonly gaugeDeltas: Array<`${"active" | "blocked"}:${1 | -1}`> = [];
  readonly counters: string[] = [];
  readonly histograms: Array<{ name: string; value: number }> = [];
  readonly transport: string[] = [];
  readonly admission: string[] = [];
  readonly gateway: string[] = [];

  gaugeDelta(name: "active" | "blocked", delta: 1 | -1): void {
    this.gaugeDeltas.push(`${name}:${delta}`);
  }

  counter(name: "opened" | "ready" | "slow" | "expired" | "closed"): void {
    this.counters.push(name);
  }

  histogram(name: "time_to_ready" | "lifetime" | "blocked_duration" | "backlog", value: number): void {
    this.histograms.push({ name, value });
  }

  assertRedacted(): void {
    const serialized = JSON.stringify({
      transport: this.transport,
      admission: this.admission,
      gateway: this.gateway,
      counters: this.counters,
      histograms: this.histograms.map(({ name }) => name),
    });
    expect(serialized).not.toContain(workspaceA);
    expect(serialized).not.toContain(accountA);
    expect(serialized).not.toContain("crawl.progress");
    expect(serialized).not.toContain("redis://");
  }
}

type Stack = {
  publisher: RedisInvalidationPublisher;
  subscriber: RedisWorkspaceInterestSubscriber;
  admissionClient: RedisAdmissionCommandClient;
  admission: RedisAdmissionController;
  gateway: WorkspaceGateway;
  telemetry: FixedCardTelemetry;
  publisherReadyCount: number;
  waitForPublisherReady(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
};

type StackInput = {
  publisherUrl?: string;
  subscriberUrl?: string;
  admissionUrl?: string;
  maxWorkspaces?: number;
  transportLossGraceMs?: number;
  leaseTtlMs?: number;
  renewalMs?: number;
  cleanupLimit?: number;
  safetyMs?: number;
};

const limits = (input: StackInput): ConstructorParameters<typeof RedisAdmissionController>[0]["limits"] => ({
  account: 100,
  workspace: 100,
  principal: 100,
  pendingPerAggregate: 8,
  leaseTtlMs: input.leaseTtlMs ?? 8_000,
  renewalMs: input.renewalMs ?? 1_000,
  renewalJitterPercent: 0,
  safetyMs: input.safetyMs ?? 500,
  closeJitterMaxMs: 0,
  cleanupLimit: input.cleanupLimit ?? 1,
  localProcessCap: 900,
  accountSweeperMaxAccounts: 128,
  reconnect: {
    account: { limit: 100, windowMs: 60_000, burst: 100 },
    workspace: { limit: 100, windowMs: 60_000, burst: 100 },
    principal: { limit: 100, windowMs: 60_000, burst: 100 },
  },
});

const createStack = async (prefix: string, input: StackInput = {}): Promise<Stack> => {
  if (!configuredRedisUrl) throw new Error("REALTIME_INTEGRATION_REDIS_URL is not configured");
  const telemetry = new FixedCardTelemetry();
  const common = {
    connectTimeoutMs: 1_000,
    queuedCommands: 32,
    seeds: [configuredRedisUrl],
    tls: false,
  };
  const publisherUrl = input.publisherUrl ?? configuredRedisUrl;
  const subscriberUrl = input.subscriberUrl ?? configuredRedisUrl;
  const publisherFactoryBase = createNodeRedisClientFactory({ ...common, url: publisherUrl });
  let publisherReadyCount = 0;
  const publisherFactory: RedisLogicalClientFactory = (request) => {
    const client = publisherFactoryBase(request);
    client.on("ready", () => { publisherReadyCount += 1; });
    return client;
  };
  const subscriberFactory = createNodeRedisClientFactory({ ...common, url: subscriberUrl });
  const publisher = new RedisInvalidationPublisher({
    channelPrefix: prefix,
    commandTimeoutMs: 500,
    createClient: publisherFactory,
    mode: "standalone",
    telemetry: { event: (outcome) => telemetry.transport.push(outcome) },
  });
  const subscriber = new RedisWorkspaceInterestSubscriber({
    channelPrefix: prefix,
    commandTimeoutMs: 500,
    createClient: subscriberFactory,
    mode: "standalone",
    maxWorkspaceInterests: input.maxWorkspaces ?? 900,
    restoreRetryBaseMs: 10,
    restoreRetryMaxMs: 200,
    restoreRetryJitter: () => 0,
    telemetry: { event: (outcome) => telemetry.transport.push(outcome) },
  });
  const admissionUrl = input.admissionUrl ?? configuredRedisUrl;
  const admissionClient = new RedisAdmissionCommandClient({
    mode: "standalone",
    url: admissionUrl,
    seeds: [admissionUrl],
    tls: false,
    queuedCommands: 32,
    connectTimeoutMs: 1_000,
    commandTimeoutMs: 500,
    telemetry: { event: (outcome) => telemetry.admission.push(outcome) },
  });
  const admission = new RedisAdmissionController({
    redis: admissionClient,
    prefix,
    limits: limits(input),
    instanceId: `instance-${randomUUID()}`,
    random: () => 0.5,
    telemetry: { event: (outcome) => telemetry.admission.push(outcome) },
  });
  const gateway = new WorkspaceGateway({
    continuity: subscriber,
    transport: subscriber,
    maxWorkspaces: input.maxWorkspaces ?? 900,
    transportLossGraceMs: input.transportLossGraceMs ?? 1_500,
    releaseGraceMs: 0,
    telemetry: {
      event: (outcome) => telemetry.gateway.push(outcome),
      state: () => undefined,
    },
  });
  try {
    await Promise.all([subscriber.start(), admissionClient.start()]);
  } catch (error) {
    await gateway.shutdown();
    admission.close();
    await Promise.allSettled([subscriber.close(), publisher.close(), admissionClient.close()]);
    throw error;
  }
  return {
    publisher,
    subscriber,
    admissionClient,
    admission,
    gateway,
    telemetry,
    get publisherReadyCount() { return publisherReadyCount; },
    waitForPublisherReady: async (count, timeoutMs = 5_000) => {
      await waitFor(() => publisherReadyCount >= count, timeoutMs);
    },
    close: async () => {
      // The order is part of the shutdown contract: detach local sessions and
      // close the controller before the command client and subscriber.
      await gateway.shutdown().catch(() => undefined);
      admission.close();
      await Promise.allSettled([subscriber.close(), publisher.close(), admissionClient.close()]);
    },
  };
};

const createPresenter = (stack: Stack, workspaceId: string, telemetry = stack.telemetry) => {
  const response = new IntegrationResponse();
  const limits: SsePresenterLimits = {
    streamAgeMs: 120_000,
    gatewayTimeoutMs: 120_000,
    edgeTimeoutMs: 120_000,
    heartbeatMs: 250,
    blockedDurationMs: 1_000,
    blockedWritableBytes: 1_000_000,
    frameBytes: 4_096,
    authTimeoutMs: 1_000,
    subscribeTimeoutMs: 2_000,
  };
  const presenter = new SsePresenter({
    authorize: async () => ({
      accountId: accountA,
      workspaceId,
      principalId: principalA,
      sessionExpiresAt: new Date(Date.now() + 300_000),
    }),
    admission: stack.admission,
    gateway: stack.gateway,
    response,
    clock: {
      monotonicNow: () => performance.now(),
      wallNow: () => Date.now(),
      setTimeout: (callback, delay) => setTimeout(callback, delay) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    },
    limits,
    telemetry,
  });
  return { presenter, response, promise: presenter.start() };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for realtime integration state");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const boundedStackClose = async (stack: Stack): Promise<void> => {
  await expect(withTimeout(stack.close(), 2_000)).resolves.toBeUndefined();
};

const admitAfterCleanupSweep = async (
  stack: Stack,
  input: { accountId: string; workspaceId: string; principalId: string },
  timeoutMs = 5_000,
): Promise<RealtimeAdmissionLease> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await stack.admission.admit(input);
    } catch (error) {
      if (!(error instanceof RealtimeAdmissionError) || error.reason !== "cleanup_backlog") throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw new Error("Redis admission cleanup sweep did not drain within its bounded deadline");
};

const parseFrame = (raw: string | undefined): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  const line = raw.split("\n").find((candidate) => candidate.startsWith("data: "));
  return line ? JSON.parse(line.slice("data: ".length)) as Record<string, unknown> : undefined;
};

const frame = (response: IntegrationResponse, event: string): Record<string, unknown> | undefined =>
  parseFrame(response.frames.find((candidate) => candidate.startsWith(`event: ${event}\n`)));

const makeConnection = (
  workspaceId: string,
  id: string,
  received: WorkspaceInvalidationKind[],
  closes: string[],
  resyncs: { count: number } = { count: 0 },
): WorkspaceGatewayConnection => ({
  connectionId: id,
  workspaceId,
  enqueueInvalidation: (kinds) => received.push(...kinds),
  enqueueResync: () => { resyncs.count += 1; },
  requestClose: (reason) => closes.push(reason),
});

const reachable = async (url: string): Promise<boolean> => {
  const parsed = new URL(url);
  const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port) || 6379 });
  return await new Promise<boolean>((resolve) => {
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
};

redisIntegration("standalone Redis/Valkey realtime integration (T063)", () => {
  beforeAll(async () => {
    if (!configuredRedisUrl) return;
    if (new URL(configuredRedisUrl).protocol !== "redis:") {
      throw new Error("REALTIME_INTEGRATION_REDIS_URL must use redis:// for the deterministic standalone fault-proxy suite");
    }
    if (!(await reachable(configuredRedisUrl))) {
      const host = new URL(configuredRedisUrl).host;
      throw new Error(`REALTIME_INTEGRATION_REDIS_URL is set but Redis/Valkey is unreachable (host: ${host}); refusing to silently skip T063`);
    }
  });

  const stacks: Stack[] = [];
  const proxies: RedisFaultProxy[] = [];

  afterEach(async () => {
    const activeStacks = stacks.splice(0);
    const activeProxies = proxies.splice(0);
    // Exercise close while faults are still active. Restore only after every
    // already-closed or bounded stack teardown has had its turn.
    const closeResults = await Promise.all(activeStacks.map((stack) => boundedStackClose(stack).then(() => undefined, (error: unknown) => error)));
    await Promise.allSettled(activeProxies.map((proxy) => proxy.restore()));
    await Promise.allSettled(activeProxies.map((proxy) => proxy.close()));
    for (const result of closeResults) expect(result).toBeUndefined();
  });

  it("publishes exact workspace-scoped kinds, tolerates duplicate delivery, and fans out one interest", async () => {
    const prefix = `t063-isolation-${randomUUID()}`;
    const stack = await createStack(prefix);
    stacks.push(stack);
    const receivedA1: WorkspaceInvalidationKind[] = [];
    const receivedA2: WorkspaceInvalidationKind[] = [];
    const receivedB: WorkspaceInvalidationKind[] = [];
    const closes: string[] = [];
    const attachmentA = await stack.gateway.attach(makeConnection(workspaceA, "connection-a", receivedA1, closes), {});
    // This publication is intentionally immediate after the first attach: the
    // broker acknowledgement must already imply a live interest.
    await stack.publisher.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: ["crawl.progress", "crawl.status_changed"] }, { signal: new AbortController().signal });
    await waitFor(() => receivedA1.length === 2);
    expect(receivedA1).toEqual(["crawl.progress", "crawl.status_changed"]);
    const attachmentA2 = await stack.gateway.attach(makeConnection(workspaceA, "connection-a2", receivedA2, closes), {});
    const attachmentB = await stack.gateway.attach(makeConnection(workspaceB, "connection-b", receivedB, closes), {});

    await stack.publisher.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: ["crawl.progress", "crawl.status_changed"] }, { signal: new AbortController().signal });
    await waitFor(() => receivedA1.length === 4 && receivedA2.length === 2);
    expect(receivedA1).toEqual(["crawl.progress", "crawl.status_changed", "crawl.progress", "crawl.status_changed"]);
    expect(receivedA2).toEqual(["crawl.progress", "crawl.status_changed"]);
    expect(receivedB).toEqual([]);
    expect(stack.telemetry.gateway.filter((event) => event === "subscribed")).toHaveLength(2);

    await attachmentA.release();
    await attachmentA2.release();
    await attachmentB.release();
    await waitFor(() => stack.telemetry.gateway.filter((event) => event === "released").length === 2);
    expect(closes).toEqual([]);
  }, 30_000);

  it("enforces workspace cap before broker subscribe and removes the final interest", async () => {
    const prefix = `t063-cap-${randomUUID()}`;
    const stack = await createStack(prefix, { maxWorkspaces: 1 });
    stacks.push(stack);
    const received: WorkspaceInvalidationKind[] = [];
    const closes: string[] = [];
    const attachment = await stack.gateway.attach(makeConnection(workspaceA, "cap-a", received, closes), {});
    await expect(stack.gateway.attach(makeConnection(workspaceB, "cap-b", received, closes), {})).rejects.toThrow(/capacity/i);
    expect(stack.telemetry.gateway.filter((event) => event === "subscribed")).toHaveLength(1);
    await attachment.release();
    await waitFor(() => stack.telemetry.gateway.filter((event) => event === "released").length === 1);
    expect(received).toEqual([]);
  }, 30_000);

  it("restores desired subscriptions before one resync, never replays stale data, and closes after loss grace", async () => {
    const subscriberProxy = await RedisFaultProxy.start({ target: new URL(configuredRedisUrl!) });
    proxies.push(subscriberProxy);
    const prefix = `t063-continuity-${randomUUID()}`;
    const stack = await createStack(prefix, { subscriberUrl: subscriberProxy.url, transportLossGraceMs: 1_500 });
    stacks.push(stack);
    const telemetry = stack.telemetry;
    const presenter = createPresenter(stack, workspaceA, telemetry);
    await waitFor(() => presenter.response.frames.length > 0);
    await waitFor(() => frame(presenter.response, "ready") !== undefined);
    expect(presenter.response.frames[0]).toContain("event: ready");
    const receivedB: WorkspaceInvalidationKind[] = [];
    const closesB: string[] = [];
    const resyncsB = { count: 0 };
    const attachmentB = await stack.gateway.attach(makeConnection(workspaceB, "continuity-b", receivedB, closesB, resyncsB), {});

    const health: string[] = [];
    const continuity: Array<{ generation: number; state: "lost" | "restored" }> = [];
    const removeHealth = stack.gateway.onHealth(({ state }) => health.push(state));
    const removeContinuity = stack.subscriber.onContinuity((event) => continuity.push(event));
    await subscriberProxy.cut();
    await waitFor(() => health.includes("degraded"));
    await waitFor(() => continuity.some((event) => event.state === "lost"));
    const firstLoss = continuity.find((event) => event.state === "lost")!;
    expect(continuity).toEqual([firstLoss]);
    const invalidationsDuringLoss = presenter.response.frames.filter((value) => value.startsWith("event: invalidate")).length;
    const resyncsDuringLoss = presenter.response.frames.filter((value) => value.startsWith("event: resync")).length;
    await stack.publisher.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: ["crawl.status_changed"] }, { signal: new AbortController().signal });
    expect(presenter.response.frames.filter((value) => value.startsWith("event: invalidate")).length).toBe(invalidationsDuringLoss);
    expect(presenter.response.frames.filter((value) => value.startsWith("event: resync")).length).toBe(resyncsDuringLoss);

    await subscriberProxy.restore();
    await waitFor(() => continuity.some((event) => event.state === "restored" && event.generation === firstLoss.generation));
    expect(continuity).toEqual([firstLoss, { generation: firstLoss.generation, state: "restored" }]);
    await waitFor(() => health.includes("restored"));
    await waitFor(() => presenter.response.frames.some((value) => value.startsWith("event: resync")));
    expect(presenter.response.frames.filter((value) => value.startsWith("event: resync"))).toHaveLength(1);
    expect(resyncsB.count).toBe(1);
    const beforeFreshInvalidations = presenter.response.frames.filter((value) => value.startsWith("event: invalidate")).length;
    const freshKind: WorkspaceInvalidationKind = "crawl.progress";
    await stack.publisher.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: [freshKind] }, { signal: new AbortController().signal });
    await waitFor(() => presenter.response.frames
      .filter((value) => value.startsWith("event: invalidate"))
      .some((value) => (parseFrame(value)?.changeKinds as string[] | undefined)?.includes(freshKind)));
    const freshInvalidations = presenter.response.frames.filter((value) => value.startsWith("event: invalidate"));
    expect(freshInvalidations.length).toBe(beforeFreshInvalidations + 1);
    expect(freshInvalidations.some((value) => (parseFrame(value)?.changeKinds as string[] | undefined)?.includes(freshKind))).toBe(true);
    await attachmentB.release();
    removeHealth();
    presenter.response.emit("close");
    await withTimeout(presenter.promise, 5_000);

    // A second outage is held by the gateway and then actively closes the
    // committed stream with provider-neutral transport_lost.
    const second = createPresenter(stack, workspaceA, telemetry);
    await waitFor(() => frame(second.response, "ready") !== undefined);
    await subscriberProxy.cut();
    await waitFor(() => continuity.filter((event) => event.state === "lost").length === 2);
    expect(continuity.filter((event) => event.state === "lost")[1]?.generation).toBe(firstLoss.generation + 1);
    await waitFor(() => second.response.endCount === 1, 4_000);
    expect(second.response.destroyCount).toBe(0);
    await withTimeout(second.promise, 5_000);
    await expect(withTimeout(stack.close(), 2_000)).resolves.toBeUndefined();
    await expect(withTimeout(stack.close(), 2_000)).resolves.toBeUndefined();
    removeContinuity();
  }, 30_000);

  it("bounds publisher outage, avoids stale delivery, and recovers on fresh publication", async () => {
    const publisherProxy = await RedisFaultProxy.start({ target: new URL(configuredRedisUrl!) });
    proxies.push(publisherProxy);
    const prefix = `t063-publisher-${randomUUID()}`;
    const stack = await createStack(prefix, { publisherUrl: publisherProxy.url });
    stacks.push(stack);
    const received: WorkspaceInvalidationKind[] = [];
    const closes: string[] = [];
    const attachment = await stack.gateway.attach(makeConnection(workspaceA, "publisher-a", received, closes), {});
    await stack.publisher.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: ["crawl.progress"] }, { signal: new AbortController().signal });
    await stack.waitForPublisherReady(1);
    const initialPublisherReadyCount = stack.publisherReadyCount;
    await waitFor(() => received.length === 1);
    await publisherProxy.cut();
    await expect(withTimeout(stack.publisher.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: ["crawl.status_changed"] }, { signal: new AbortController().signal }), 2_000)).rejects.toThrow();
    expect(received).toEqual(["crawl.progress"]);
    await publisherProxy.restore();
    await stack.waitForPublisherReady(initialPublisherReadyCount + 1);
    const freshKind: WorkspaceInvalidationKind = "crawl.status_changed";
    await stack.publisher.publish({ protocolVersion: 1, workspaceId: workspaceA, changeKinds: [freshKind] }, { signal: new AbortController().signal });
    await waitFor(() => received.includes(freshKind));
    expect(received.filter((kind) => kind === freshKind)).toHaveLength(1);
    await attachment.release();
    expect(closes).toEqual([]);
  }, 30_000);

  it("uses Redis server-time expiry and bounded cleanup sweeps after a controller crash", async () => {
    const prefix = `t063-expiry-${randomUUID()}`;
    const crashed = await createStack(prefix, { leaseTtlMs: 500, safetyMs: 50, renewalMs: 10_000, cleanupLimit: 1 });
    stacks.push(crashed);
    const first = await crashed.admission.admit({ accountId: accountA, workspaceId: workspaceA, principalId: `${principalA}-expired-0` });
    const firstExpiry = (first as RealtimeAdmissionLease & { expiresAtMs: number }).expiresAtMs;
    await waitFor(() => performance.now() >= firstExpiry - 400, 5_000);
    const second = await crashed.admission.admit({ accountId: accountA, workspaceId: workspaceA, principalId: `${principalA}-expired-1` });
    const secondExpiry = (second as RealtimeAdmissionLease & { expiresAtMs: number }).expiresAtMs;
    await waitFor(() => performance.now() >= secondExpiry - 400, 5_000);
    await crashed.admission.admit({ accountId: accountA, workspaceId: workspaceA, principalId: `${principalA}-still-live` });

    // Simulate a crashed owner: no release calls are made, and the first
    // controller's maintenance scheduler/Redis client are gone.
    crashed.admission.close();
    await crashed.admissionClient.close();
    await waitFor(() => performance.now() >= secondExpiry + 75, 5_000);

    const recovery = await createStack(prefix, { leaseTtlMs: 500, safetyMs: 50, renewalMs: 10_000, cleanupLimit: 1 });
    stacks.push(recovery);
    const cleanupHealth: string[] = [];
    const removeHealth = recovery.admission.onHealth(({ state }) => cleanupHealth.push(state));
    const replacementInput = { accountId: accountA, workspaceId: workspaceB, principalId: `${principalA}-replacement` };
    await expect(recovery.admission.admit(replacementInput)).rejects.toMatchObject({ reason: "cleanup_backlog", statusCode: 503 });
    expect(recovery.telemetry.admission).toContain("degraded");
    const recovered = await admitAfterCleanupSweep(recovery, replacementInput);
    await recovered.release();
    await waitFor(() => recovery.admission.schedulerCount() === 0 && recovery.admission.pendingAggregateCount() === 0, 5_000);
    expect(recovery.telemetry.admission).toContain("accepted");
    expect(recovery.telemetry.admission.filter((outcome) => outcome === "degraded").length).toBeLessThanOrEqual(10);
    expect(cleanupHealth).toContain("degraded");
    expect(cleanupHealth).toContain("restored");
    removeHealth();
  }, 30_000);

  it("closes a fresh presenter once on admission degradation before valid expiry, then recovers", async () => {
    const admissionProxy = await RedisFaultProxy.start({ target: new URL(configuredRedisUrl!) });
    proxies.push(admissionProxy);
    const prefix = `t063-risk-${randomUUID()}`;
    const stack = await createStack(prefix, { admissionUrl: admissionProxy.url, leaseTtlMs: 5_000, safetyMs: 1_000, renewalMs: 500, cleanupLimit: 1 });
    stacks.push(stack);
    const health: string[] = [];
    const clientHealth: string[] = [];
    const removeHealth = stack.admission.onHealth(({ state }) => health.push(state));
    const removeClientHealth = stack.admissionClient.onHealth((state) => clientHealth.push(state));
    const presenter = createPresenter(stack, workspaceA);
    await waitFor(() => frame(presenter.response, "ready") !== undefined);
    expect(presenter.response.committed).toBe(true);
    expect(presenter.response.endCount + presenter.response.destroyCount).toBe(0);
    const outageStartedAt = performance.now();
    await admissionProxy.cut();
    await withTimeout(stack.admissionClient.health(), 2_000).catch(() => undefined);
    await waitFor(() => health.includes("degraded"), 8_000);
    await waitFor(() => presenter.response.endCount + presenter.response.destroyCount === 1, 8_000);
    expect(presenter.response.endCount).toBe(1);
    expect(presenter.response.destroyCount).toBe(0);
    expect(performance.now() - outageStartedAt).toBeLessThan(5_000);
    presenter.response.emit("close");
    await withTimeout(presenter.promise, 5_000);

    await admissionProxy.restore();
    await waitFor(() => clientHealth.includes("ready"), 5_000);
    await stack.admission.checkReconnect({ accountId: accountA, workspaceId: workspaceB, principalId: principalA });
    const recovered = await stack.admission.admit({ accountId: accountA, workspaceId: workspaceB, principalId: principalA });
    await recovered.release();
    expect(stack.telemetry.admission).toContain("accepted");
    removeHealth();
    removeClientHealth();
  }, 30_000);

  it("shuts down idempotently with no leaked stream ownership and fixed-card redacted telemetry", async () => {
    const prefix = `t063-shutdown-${randomUUID()}`;
    const stack = await createStack(prefix);
    stacks.push(stack);
    const presenter = createPresenter(stack, workspaceA);
    await waitFor(() => frame(presenter.response, "ready") !== undefined);
    presenter.response.emit("finish");
    await withTimeout(presenter.promise, 5_000);
    await Promise.all([stack.close(), stack.close()]);
    expect(presenter.response.endCount).toBe(0);
    expect(presenter.response.destroyCount).toBe(0);
    expect(presenter.response.listenerCount()).toBe(0);
    expect(stack.telemetry.gaugeDeltas.filter((value) => value === "active:1")).toHaveLength(1);
    expect(stack.telemetry.gaugeDeltas.filter((value) => value === "active:-1")).toHaveLength(1);
    expect(stack.telemetry.counters).toContain("opened");
    expect(stack.telemetry.counters).toContain("ready");
    expect(stack.telemetry.counters).toContain("closed");
    stack.telemetry.assertRedacted();
  }, 30_000);
});
