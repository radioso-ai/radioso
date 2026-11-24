import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerApiRequestSkillExecutor } from "../../../src/app/server/builders/apiRequestSkills.js";
import { createRoutineSkillResolverChain } from "../../../src/modules/routines/public.js";
import { RoutineSkillExecutorDispatcher } from "../../../src/modules/routines/skillDispatcher.js";
import { SkillExecutorRegistry } from "../../../src/modules/skills/public.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";
import { initializeTracing, shutdownTracing } from "../../../src/shared/observability/tracing/index.js";
import type { AppLogger } from "../../../src/shared/observability/logger.js";
import type { AgentSkillSpine } from "../../../src/modules/agentSkills/public.js";

// A routine step reaches the API request executor through the dispatcher and the registry the app
// composes. These tests pin that the span, counter and failure log fire on that path.

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const skill = {
  id: "44444444-4444-4444-8444-444444444444",
  agentId,
  workspaceId,
  skillName: "order_status",
  kind: "api_request",
  invocationMode: "routine_named",
  enabled: true,
  targetType: "api_connection",
  targetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  config: {
    method: "GET",
    path: "/orders/{order_number}",
    exposedParams: { order_number: { type: "text", slotBinding: "order" } },
    boundParams: {},
    outputs: { order_status: { path: "status", type: "text" } },
  },
} as unknown as AgentSkillSpine;

class RecordingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
    this.spans.push(...spans);
    callback({ code: 0 });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const routineStep = async () => {
  const metrics = new MetricsRegistry();
  const warn = vi.fn();
  const logger = { warn } as unknown as AppLogger;
  const registry = new SkillExecutorRegistry();
  registerApiRequestSkillExecutor(
    registry,
    { findByName: async () => skill },
    {
      apiConnections: {
        resolveTarget: async (_ws: string, id: string) => ({
          kind: "found" as const,
          target: { id, baseUrl: "https://10.0.0.1/v1", authScheme: "none" as const, authHeaderName: null, credential: null, defaultHeaders: {} },
        }),
      } as never,
      env: { NODE_ENV: "test" } as never,
      metricsRegistry: metrics,
      logger,
    },
  );
  const dispatcher = new RoutineSkillExecutorDispatcher(
    createRoutineSkillResolverChain({
      webhookSkillNames: [],
      emailSkillNames: [],
      slackSkillNames: [],
      retrieveSkills: [],
      notifySkills: [],
      apiRequestSkills: [skill],
    }),
    registry,
    { workspaceId },
  );
  // The registered executor sends through the public egress policy, which refuses this private
  // address before any lookup or socket; the outcome under test is therefore a failed dispatch.
  const result = await dispatcher.dispatch({
    skillName: "order_status",
    state: { routineId: "r-1", path: ["s-1"], variables: { order: "A-100" } },
    turn: { sessionId: "c-1", agent: { id: agentId }, inputEvent: { id: "m-1", kind: "message", content: "" }, history: [], stagedContext: [], steering: [] },
  } as never);
  return { result, metrics, warn };
};

describe("API request skill observability on the routine dispatch path", () => {
  afterEach(async () => {
    await shutdownTracing();
  });

  it("wraps the dispatch in its span, counts the outcome and logs the failure by ids and reason", async () => {
    const exporter = new RecordingExporter();
    initializeTracing({
      enabled: true,
      environment: "test",
      otlpEndpoint: "http://localhost:4318/v1/traces",
      runtimeRole: "api",
      serviceName: "radioso-api",
      spanExporter: exporter,
    });

    const { result, metrics, warn } = await routineStep();

    expect(result).toMatchObject({ status: "failed" });
    const span = exporter.spans.find((candidate) => candidate.name === "api_request.skill.dispatch");
    expect(span?.attributes).toMatchObject({ "skill.name": "order_status", "api_request.outcome": "failed" });
    expect(metrics.renderPrometheus()).toMatch(/api_request_skill_dispatch_total\{[^}]*outcome="failed"[^}]*reason="[a-z_]+"[^}]*\} 1/u);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ event: "api_request_skill_failed", workspaceId, agentId, skillName: "order_status" });
    expect(fields).toMatchObject({ reason: "blocked" });
    expect(JSON.stringify(fields)).not.toContain("10.0.0.1");
  });
});
