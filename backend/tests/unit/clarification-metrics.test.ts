import { describe, expect, it } from "vitest";

import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { recordClarificationDecision } from "../../src/modules/chat/services/clarification/clarificationMetrics.js";

describe("clarification metrics", () => {
  it("records only surface and decision labels", () => {
    const registry = new MetricsRegistry();

    recordClarificationDecision(registry, { surface: "routine_activation", decision: "asked" });
    recordClarificationDecision(registry, { surface: "routine_activation", decision: "asked" });

    expect(registry.renderPrometheus()).toContain(
      'radioso_clarification_decisions_total{decision="asked",surface="routine_activation"} 2',
    );
    expect(registry.renderPrometheus()).not.toContain("candidate");
    expect(registry.renderPrometheus()).not.toContain("payload");
  });
});
