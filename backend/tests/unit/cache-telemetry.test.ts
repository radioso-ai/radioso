import { describe, expect, it } from "vitest";

import { recordCacheInferenceTelemetry } from "../../src/shared/infra/llm/cacheTelemetry.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";

describe("cache inference telemetry", () => {
  it("uses only bounded labels and never emits request content or identities", () => {
    const metrics = new MetricsRegistry();
    recordCacheInferenceTelemetry(metrics, {
      metadata: { capability: "chat", provider: "claude", model: "private-model-token", cacheCapability: "explicit_checkpoint" },
      surface: "workspace-secret",
      operation: "private_operation",
      accounting: { state: "reported", readInputTokens: 0, writeInputTokens: 4 },
      outcome: "succeeded",
      durationMs: 25,
      timingBoundary: "provider_invocation",
    });

    const rendered = metrics.renderPrometheus();
    expect(rendered).toContain('capability="explicit_checkpoint"');
    expect(rendered).toContain('accounting_state="reported"');
    expect(rendered).toContain('surface="other"');
    expect(rendered).toContain('operation="other"');
    expect(rendered).not.toContain("workspace-secret");
    expect(rendered).not.toContain("private_operation");
    expect(rendered).not.toContain("private-model-token");
  });

  it("tolerates a broken metrics sink", () => {
    expect(() => recordCacheInferenceTelemetry({
      incrementCounter() { throw new Error("telemetry unavailable"); },
      observeHistogram() { throw new Error("telemetry unavailable"); },
    }, {
      metadata: { capability: "chat", provider: "openai", model: "gpt" },
      surface: "assistant",
      operation: "answer",
      outcome: "succeeded",
      timingBoundary: "provider_invocation",
    })).not.toThrow();
  });
});
