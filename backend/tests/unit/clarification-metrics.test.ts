import { describe, expect, it } from "vitest";

import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { recordClarificationDecision } from "../../src/modules/chat/services/clarification/clarificationMetrics.js";

describe("clarification metrics", () => {
  it("records surface, decision, and a bounded reason label", () => {
    const registry = new MetricsRegistry();

    recordClarificationDecision(registry, { surface: "routine_activation", decision: "asked", reason: "ask" });
    recordClarificationDecision(registry, { surface: "routine_activation", decision: "asked", reason: "ask" });
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "offered", reason: "soft_band" });
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "auto_picked", reason: "label_fallback" });
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "not_clarified", reason: "compatible_facets" });
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "auto_picked", reason: "phrasing_fallback" });
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "not_clarified", reason: "redundant_sources" });

    const rendered = registry.renderPrometheus();
    expect(rendered).toContain(
      'radioso_clarification_decisions_total{decision="asked",reason="ask",surface="routine_activation"} 2',
    );
    expect(rendered).toContain(
      'radioso_clarification_decisions_total{decision="offered",reason="soft_band",surface="retrieval_sense"} 1',
    );
    expect(rendered).toContain(
      'radioso_clarification_decisions_total{decision="auto_picked",reason="label_fallback",surface="retrieval_sense"} 1',
    );
    expect(rendered).toContain(
      'radioso_clarification_decisions_total{decision="not_clarified",reason="compatible_facets",surface="retrieval_sense"} 1',
    );
    expect(rendered).toContain(
      'radioso_clarification_decisions_total{decision="auto_picked",reason="phrasing_fallback",surface="retrieval_sense"} 1',
    );
    expect(rendered).toContain(
      'radioso_clarification_decisions_total{decision="not_clarified",reason="redundant_sources",surface="retrieval_sense"} 1',
    );
  });

  it("keeps the decision reason optional so resolution outcomes stay low-cardinality", () => {
    const registry = new MetricsRegistry();

    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "offer_accepted_alternative" });
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "offer_ignored" });

    const rendered = registry.renderPrometheus();
    expect(rendered).toContain(
      'radioso_clarification_decisions_total{decision="offer_accepted_alternative",surface="retrieval_sense"} 1',
    );
    expect(rendered).toContain(
      'radioso_clarification_decisions_total{decision="offer_ignored",surface="retrieval_sense"} 1',
    );
  });

  it("keeps ask-rate derivable and free of content", () => {
    const registry = new MetricsRegistry();

    // A surface's ask-rate is asked / sum(all decisions on that surface); every
    // decision this test records is enumerable, so the denominator is bounded.
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "asked", reason: "ask" });
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "auto_picked", reason: "clear_margin" });
    recordClarificationDecision(registry, { surface: "retrieval_sense", decision: "not_clarified", reason: "compatible_facets" });

    const rendered = registry.renderPrometheus();
    expect(rendered).not.toContain("candidate");
    expect(rendered).not.toContain("payload");
    expect(rendered).not.toContain("How do I upload a document via the REST API?");
  });
});
