import { describe, expect, it } from "vitest";

import { REDACTED_VALUE } from "../../src/modules/context-variables/redaction.js";
import { projectContextForMatching } from "../../src/modules/context-variables/matchContextProjection.js";

const bound = { maxRenderedVariables: 3, perValueMaxChars: 40, sectionTokenBudget: 1_000 };
const roomyBound = { maxRenderedVariables: 3, perValueMaxChars: 300, sectionTokenBudget: 1_000 };

describe("projectContextForMatching", () => {
  it("returns an empty projection when the turn resolved no context", () => {
    expect(projectContextForMatching({})).toEqual({ context: {}, dropped: [], clamped: [] });
  });

  it("keeps resolved variable values under their own names, with their JSON types intact", () => {
    const projection = projectContextForMatching(
      { cart_value: 120, loyalty_tier: "gold", subscribed: true },
      bound,
    );

    expect(projection.context).toEqual({ cart_value: 120, loyalty_tier: "gold", subscribed: true });
  });

  it("carries the redaction marker through instead of a sensitive value", () => {
    const projection = projectContextForMatching({ customer_email: REDACTED_VALUE }, bound);

    expect(projection.context.customer_email).toBe(REDACTED_VALUE);
  });

  it("projects page context to its locating fields and omits the page excerpt", () => {
    const projection = projectContextForMatching(
      {
        page_context: {
          kind: "page_context",
          pageUrl: "https://shop.example/cart",
          pageTitle: "Your cart",
          pageLocale: "en-GB",
          browserLocale: "en-GB",
          content: "a very long visible page excerpt that belongs in the answer prompt, not here",
        },
      },
      roomyBound,
    );

    expect(projection.context.page_context).toEqual({
      pageUrl: "https://shop.example/cart",
      pageTitle: "Your cart",
      pageLocale: "en-GB",
      browserLocale: "en-GB",
    });
  });

  it("omits page context that resolved no locating fields", () => {
    const projection = projectContextForMatching({ page_context: { kind: "page_context" } }, bound);

    expect(projection.context).toEqual({});
  });

  it("clamps an oversized value and reports the clamp", () => {
    const projection = projectContextForMatching({ order_history: "x".repeat(500) }, bound);

    expect(String(projection.context.order_history)).toContain("[truncated]");
    expect(String(projection.context.order_history).length).toBeLessThanOrEqual(40);
    expect(projection.clamped).toEqual([
      { variableName: "order_history", originalChars: 502, retainedChars: 40 },
    ]);
  });

  it("drops variables past the count cap and reports the drop", () => {
    const projection = projectContextForMatching(
      { a: 1, b: 2, c: 3, d: 4 },
      bound,
    );

    expect(Object.keys(projection.context)).toEqual(["a", "b", "c"]);
    expect(projection.dropped).toEqual([{ variableName: "d", reason: "count_cap" }]);
  });

  it("drops variables past the section token budget and reports the drop", () => {
    const projection = projectContextForMatching(
      { a: "x".repeat(30), b: "y".repeat(30) },
      { maxRenderedVariables: 5, perValueMaxChars: 100, sectionTokenBudget: 8 },
    );

    expect(Object.keys(projection.context)).toEqual(["a"]);
    expect(projection.dropped).toEqual([{ variableName: "b", reason: "token_budget" }]);
  });
});
