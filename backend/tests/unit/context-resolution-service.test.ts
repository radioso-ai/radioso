import { describe, expect, it } from "vitest";

import { resolveContextForTurn } from "../../src/modules/context-variables/public.js";

describe("resolveContextForTurn", () => {
  it("stages page context as a context variable and returns a redacted snapshot", () => {
    const result = resolveContextForTurn({
      pageUrl: "https://example.test/docs",
      pageTitle: "Docs",
      pageLocale: "en-US",
      browserLocale: "en",
      content: "Visible page text.",
    });

    expect(result.fragments).toEqual([{
      kind: "page_context",
      pageUrl: "https://example.test/docs",
      pageTitle: "Docs",
      pageLocale: "en-US",
      browserLocale: "en",
      content: "Visible page text.",
    }]);
    expect(result.staged).toEqual([{
      kind: "context_variable",
      id: "page_context",
      data: result.fragments[0],
      metadata: {
        variableName: "page_context",
        trustTier: "unverified",
      },
    }]);
    expect(result.snapshot).toEqual({
      page_context: result.fragments[0],
    });
    // page context is always-surfaced → rendered
    expect(result.renderFragments).toEqual([result.fragments[0]]);
  });

  it("returns empty turn context for null or empty page context", () => {
    const empty = { fragments: [], renderFragments: [], staged: [], snapshot: {} };
    expect(resolveContextForTurn(null)).toEqual(empty);
    expect(resolveContextForTurn({
      pageUrl: " ",
      pageTitle: null,
      pageLocale: undefined,
      browserLocale: "",
      content: "\n",
    })).toEqual(empty);
  });

  it("stages and snapshots host variables but only renders always-surfaced ones", () => {
    const result = resolveContextForTurn(null, [
      { name: "cart", description: "the cart", value: { items: 2 }, surfacing: "always" },
      { name: "order_status", value: "shipped", surfacing: "on_reference" },
      { name: "ssn", value: "123-45-6789", surfacing: "operator_only", sensitive: true },
    ]);

    // all three are staged for the matcher/routines
    expect(result.staged.map((entry) => entry.id)).toEqual(["cart", "order_status", "ssn"]);
    // only the always-surfaced one is rendered
    expect(result.renderFragments).toEqual([
      { kind: "variable", name: "cart", description: "the cart", value: { items: 2 }, trust: "unverified" },
    ]);
    // snapshot keeps all, with the sensitive value redacted
    expect(result.snapshot).toEqual({
      cart: { items: 2 },
      order_status: "shipped",
      ssn: "[redacted]",
    });
  });
});
