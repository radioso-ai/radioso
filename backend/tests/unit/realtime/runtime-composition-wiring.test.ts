import { describe, expect, it, vi } from "vitest";

import { createRealtimeComposition } from "../../../src/app/composition/realtimeComposition.js";
import { parseRealtimeConfig } from "../../../src/modules/realtime/infrastructure/config.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";
import type { AppLogger } from "../../../src/shared/observability/logger.js";

const captures = vi.hoisted(() => ({
  admissionClientInputs: [] as Array<Record<string, unknown>>,
  admissionControllerInputs: [] as Array<Record<string, unknown>>,
  gatewayInputs: [] as Array<Record<string, unknown>>,
  routeDeps: undefined as Record<string, unknown> | undefined,
  subscriberInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../src/modules/realtime/http/workspaceEventsRoutes.js", () => ({
  createWorkspaceEventsRoutes: vi.fn((deps: Record<string, unknown>) => {
    captures.routeDeps = deps;
    return {};
  }),
}));

vi.mock("../../../src/runtime/realtimeServer.js", () => ({
  createRealtimeServer: vi.fn(() => ({
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    forceDestroy: vi.fn(),
  })),
}));

vi.mock("../../../src/modules/realtime/infrastructure/redisInvalidationTransport.js", () => ({
  createNodeRedisClientFactory: vi.fn(() => vi.fn()),
  RedisWorkspaceInterestSubscriber: vi.fn(function (input: Record<string, unknown>) {
    captures.subscriberInputs.push(input);
    return {
      start: vi.fn(async () => undefined),
      onContinuity: vi.fn(() => () => undefined),
      subscribe: vi.fn(async () => ({ generation: 1 })),
      unsubscribe: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
  }),
}));

vi.mock("../../../src/modules/realtime/infrastructure/redisAdmissionCommandClient.js", () => ({
  RedisAdmissionCommandClient: vi.fn(function (input: Record<string, unknown>) {
    captures.admissionClientInputs.push(input);
    return {
      start: vi.fn(async () => undefined),
      health: vi.fn(async () => "ready"),
      onHealth: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };
  }),
}));

vi.mock("../../../src/modules/realtime/infrastructure/redisAdmissionController.js", () => ({
  RedisAdmissionController: vi.fn(function (input: Record<string, unknown>) {
    captures.admissionControllerInputs.push(input);
    return {
      admit: vi.fn(),
      checkReconnect: vi.fn(),
      onHealth: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };
  }),
}));

vi.mock("../../../src/modules/realtime/application/workspaceGateway.js", () => ({
  WorkspaceGateway: vi.fn(function (input: Record<string, unknown>) {
    captures.gatewayInputs.push(input);
    return {
      attach: vi.fn(),
      onHealth: vi.fn(() => () => undefined),
      shutdown: vi.fn(async () => undefined),
    };
  }),
}));

const config = () => parseRealtimeConfig({
  REALTIME_MODE: "redis-cluster",
  REALTIME_REDIS_SEEDS: "rediss://one:6379,rediss://two:6379",
  REALTIME_REDIS_TLS: true,
  REALTIME_ROLLOUT_MODE: "default-on",
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger;

describe("realtime runtime composition wiring", () => {
  it("passes an injected per-presenter stream-age sampler into the executable route", () => {
    captures.routeDeps = undefined;
    const samples = [0, 1];
    const input = {
      config: config(),
      databaseUrl: "postgres://realtime.test",
      logger,
      port: 0,
      random: () => samples.shift() ?? 0,
      sessionCookieName: "radioso_session",
    } as Parameters<typeof createRealtimeComposition>[0] & { random: () => number };
    createRealtimeComposition(input);

    const routeDeps = captures.routeDeps!;
    expect(typeof routeDeps.streamAgeMs).toBe("function");
    const streamAgeSampler = routeDeps.streamAgeMs as () => number;
    expect([streamAgeSampler(), streamAgeSampler()]).toEqual([720_000, 839_999]);
  });

  it("wires fixed-card telemetry into every runtime boundary without identifier or content labels", () => {
    captures.routeDeps = undefined;
    captures.subscriberInputs.length = 0;
    captures.admissionClientInputs.length = 0;
    captures.admissionControllerInputs.length = 0;
    captures.gatewayInputs.length = 0;
    const metrics = new MetricsRegistry();
    const composition = createRealtimeComposition({
      config: config(),
      databaseUrl: "postgres://realtime.test",
      logger,
      metrics,
      port: 0,
      sessionCookieName: "radioso_session",
    });

    composition.dependencies.subscriberFactory({});
    composition.dependencies.admissionClientFactory({});
    composition.dependencies.admissionControllerFactory({ localProcessCap: 900 });
    composition.dependencies.gatewayFactory({ maxConnections: 900, transportLossGraceMs: 20_000 });

    const subscriberTelemetry = captures.subscriberInputs[0].telemetry as Record<string, unknown>;
    const admissionClientTelemetry = captures.admissionClientInputs[0].telemetry as Record<string, unknown>;
    const admissionTelemetry = captures.admissionControllerInputs[0].telemetry as Record<string, unknown>;
    const gatewayTelemetry = captures.gatewayInputs[0].telemetry as Record<string, unknown>;
    const routeTelemetry = captures.routeDeps!.telemetry as Record<string, unknown>;
    const streamTelemetry = captures.routeDeps!.streamTelemetry as Record<string, unknown>;

    expect(subscriberTelemetry).toEqual(expect.objectContaining({ event: expect.any(Function) }));
    expect(admissionClientTelemetry).toEqual(expect.objectContaining({ event: expect.any(Function) }));
    expect(admissionTelemetry).toEqual(expect.objectContaining({ event: expect.any(Function) }));
    expect(gatewayTelemetry).toEqual(expect.objectContaining({ event: expect.any(Function), state: expect.any(Function) }));
    expect(routeTelemetry).toEqual(expect.objectContaining({ outcome: expect.any(Function) }));
    expect(streamTelemetry).toEqual(expect.objectContaining({
      gaugeDelta: expect.any(Function),
      counter: expect.any(Function),
      histogram: expect.any(Function),
    }));

    (subscriberTelemetry.event as (outcome: string) => void)("reconnect");
    (admissionClientTelemetry.event as (outcome: string) => void)("degraded");
    (admissionTelemetry.event as (outcome: string) => void)("accepted");
    (gatewayTelemetry.event as (outcome: string) => void)("resync");
    (gatewayTelemetry.state as (state: { interests: number; sessions: number; waiters: number }) => void)({ interests: 3, sessions: 4, waiters: 1 });
    (routeTelemetry.outcome as (outcome: string) => void)("ready");
    (streamTelemetry.gaugeDelta as (name: "active" | "blocked", delta: 1 | -1) => void)("active", 1);
    (streamTelemetry.gaugeDelta as (name: "active" | "blocked", delta: 1 | -1) => void)("active", -1);
    for (const outcome of ["opened", "ready", "slow", "expired", "closed"]) {
      (streamTelemetry.counter as (name: string) => void)(outcome);
    }
    for (const name of ["time_to_ready", "lifetime", "blocked_duration", "backlog"]) {
      (streamTelemetry.histogram as (name: string, value: number) => void)(name, 1);
    }

    const rendered = metrics.renderPrometheus();
    expect(rendered).not.toMatch(/4d7293c8|secret|adc-token|document-content/i);
    for (const line of rendered.split("\n").filter((line) => line.includes("{"))) {
      const labels = line.slice(line.indexOf("{") + 1, line.indexOf("}"));
      const keys = labels.split(",").filter(Boolean).map((entry) => entry.slice(0, entry.indexOf("=")));
      const isHistogramBucket = line.includes("_bucket");
      expect(keys.every((key) => key === "outcome" || (isHistogramBucket && key === "le"))).toBe(true);
    }
  });
});
