import { describe, expect, it } from "vitest";

import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { recordClarificationDecision } from "../../src/modules/chat/services/clarification/clarificationMetrics.js";

describe("clarification metrics", () => {
  it("records only surface and decision labels", () => {
    const registry = new MetricsRegistry();

    recordClarificationDecision(registry, { surface: "routine_activation", decision: "asked" });
    recordClarificationDecision(registry, { surface: "routine_activation", decision: "asked" });
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "offered" });
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "offer_accepted_alternative" });
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "offer_ignored" });

    expect(registry.renderPrometheus()).toContain(
      'radioso_clarification_decisions_total{decision="asked",surface="routine_activation"} 2',
    );
    expect(registry.renderPrometheus()).toContain(
      'radioso_clarification_decisions_total{decision="offered",surface="retrieval_sense"} 1',
    );
    expect(registry.renderPrometheus()).toContain(
      'radioso_clarification_decisions_total{decision="offer_accepted_alternative",surface="retrieval_sense"} 1',
    );
    expect(registry.renderPrometheus()).toContain(
      'radioso_clarification_decisions_total{decision="offer_ignored",surface="retrieval_sense"} 1',
    );
    expect(registry.renderPrometheus()).not.toContain("candidate");
    expect(registry.renderPrometheus()).not.toContain("payload");
    expect(registry.renderPrometheus()).not.toContain("How do I upload a document via the REST API?");
  });
});
