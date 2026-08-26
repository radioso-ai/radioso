import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const captures = vi.hoisted(() => ({ inputs: [] as Array<Record<string, any>> }));

vi.mock("../../../src/modules/realtime/http/ssePresenter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/realtime/http/ssePresenter.js")>();
  class CapturingPresenter {
    constructor(private readonly input: Record<string, any>) {
      captures.inputs.push(input);
    }

    async start(): Promise<void> {
      this.input.response.commitSse();
      this.input.response.end();
    }
  }
  return { ...actual, SsePresenter: CapturingPresenter };
});

import { createWorkspaceEventsRoutes, type WorkspaceEventsRouteDeps } from "../../../src/modules/realtime/http/workspaceEventsRoutes.js";
import { createRealtimeRolloutPolicy } from "../../../src/modules/realtime/domain/realtimeRolloutPolicy.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";

const workspaceId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
const accountId = "de305d54-75b4-431b-adb2-eb6b9e546014";
const baseLimits = {
  streamAgeMs: 840_000,
  gatewayTimeoutMs: 1_200_000,
  edgeTimeoutMs: 1_200_000,
  heartbeatMs: 20_000,
  blockedDurationMs: 10_000,
  blockedWritableBytes: 256 * 1024,
  frameBytes: 4 * 1024,
  authTimeoutMs: 2_000,
  subscribeTimeoutMs: 3_000,
};

describe("realtime route/presenter composition", () => {
  it("samples one bounded numeric stream age per request and passes it to the actual presenter", async () => {
    captures.inputs.length = 0;
    const samples = [0, 0.999999];
    const sampler = vi.fn(() => 720_000 + Math.floor((samples.shift() ?? 0) * 120_000));
    const deps = {
      authenticate: vi.fn(async () => ({ accountId, principalId: "principal-1", workspaceId, sessionExpiresAt: new Date(Date.now() + 900_000) })),
      rollout: createRealtimeRolloutPolicy({ mode: "default-on", accountIds: [] }),
      admission: {
        checkReconnect: vi.fn(async () => undefined),
        admit: vi.fn(async () => ({ risk: new Promise(() => undefined), release: vi.fn(async () => undefined) })),
      },
      gateway: { attach: vi.fn(async () => ({ generation: 1, release: vi.fn(async () => undefined) })) },
      sessionCookieName: "radioso_session",
      limits: baseLimits,
      clock: {
        monotonicNow: () => 0,
        wallNow: () => Date.now(),
        setTimeout: vi.fn(() => 1),
        clearTimeout: vi.fn(),
      },
      streamAgeMs: sampler,
    } as unknown as WorkspaceEventsRouteDeps & { streamAgeMs: () => number };
    const app = express();
    app.use("/api/v1/events", createWorkspaceEventsRoutes(deps));

    await request(app).get("/api/v1/events").set("Accept", "text/event-stream").set("X-Workspace-Id", workspaceId).set("Cookie", "radioso_session=session").expect(200);
    await request(app).get("/api/v1/events").set("Accept", "text/event-stream").set("X-Workspace-Id", workspaceId).set("Cookie", "radioso_session=session").expect(200);

    expect(sampler).toHaveBeenCalledTimes(2);
    expect(captures.inputs.map((input) => input.limits.streamAgeMs)).toEqual([720_000, 839_999]);
    expect(captures.inputs.every((input) => typeof input.limits.streamAgeMs === "number")).toBe(true);
  });

  it("passes fixed-card stream telemetry and keeps labels/value fields free of identifiers, tokens, and content", async () => {
    captures.inputs.length = 0;
    const metrics = new MetricsRegistry();
    const gaugeValues = { active: 0, blocked: 0 };
    const streamTelemetry = {
      gaugeDelta: vi.fn((name: "active" | "blocked", delta: 1 | -1) => {
        gaugeValues[name] += delta;
        metrics.setGauge(`realtime_stream_${name}`, { help: name, value: gaugeValues[name] });
      }),
      counter: vi.fn((name: string) => metrics.incrementCounter(`realtime_stream_${name}_total`, { help: name, labels: { outcome: name } })),
      histogram: vi.fn((name: string, value: number) => metrics.observeHistogram(`realtime_stream_${name}_ms`, { help: name, value })),
    };
    const deps = {
      authenticate: vi.fn(async () => ({ accountId, principalId: "principal-1", workspaceId, sessionExpiresAt: new Date(Date.now() + 900_000) })),
      rollout: createRealtimeRolloutPolicy({ mode: "default-on", accountIds: [] }),
      admission: {
        checkReconnect: vi.fn(async () => undefined),
        admit: vi.fn(async () => ({ risk: new Promise(() => undefined), release: vi.fn(async () => undefined) })),
      },
      gateway: { attach: vi.fn(async () => ({ generation: 1, release: vi.fn(async () => undefined) })) },
      sessionCookieName: "radioso_session",
      limits: baseLimits,
      clock: {
        monotonicNow: () => 0,
        wallNow: () => Date.now(),
        setTimeout: vi.fn(() => 1),
        clearTimeout: vi.fn(),
      },
      streamTelemetry,
    } as unknown as WorkspaceEventsRouteDeps & { streamTelemetry: typeof streamTelemetry };
    const app = express();
    app.use("/api/v1/events", createWorkspaceEventsRoutes(deps));
    await request(app).get("/api/v1/events").set("Accept", "text/event-stream").set("X-Workspace-Id", workspaceId).set("Cookie", "radioso_session=session").expect(200);

    const telemetry = captures.inputs[0]!.telemetry as typeof streamTelemetry;
    expect(telemetry).toBeDefined();
    telemetry.gaugeDelta("active", 1);
    telemetry.gaugeDelta("active", -1);
    telemetry.gaugeDelta("blocked", 1);
    telemetry.gaugeDelta("blocked", -1);
    for (const outcome of ["opened", "ready", "slow", "expired", "closed"]) telemetry.counter(outcome);
    telemetry.histogram("time_to_ready", 3);
    telemetry.histogram("lifetime", 4);
    telemetry.histogram("blocked_duration", 5);
    telemetry.histogram("backlog", 6);

    const rendered = metrics.renderPrometheus();
    expect(gaugeValues).toEqual({ active: 0, blocked: 0 });
    expect(rendered).toContain("radioso_realtime_stream_active 0");
    expect(rendered).toContain("radioso_realtime_stream_blocked 0");
    for (const line of rendered.split("\n").filter((line) => line.includes("{"))) {
      const labels = line.slice(line.indexOf("{") + 1, line.indexOf("}"));
      const keys = labels.split(",").filter(Boolean).map((entry) => entry.slice(0, entry.indexOf("=")));
      if (line.includes("_bucket")) {
        expect(keys).toEqual(["le"]);
      } else {
        expect(keys).toEqual(["outcome"]);
      }
    }
    expect(rendered).not.toMatch(new RegExp(`${workspaceId}|principal-1|session|secret-token|document-content`, "i"));
  });
});
