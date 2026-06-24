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
  });

  it("returns empty turn context for null or empty page context", () => {
    expect(resolveContextForTurn(null)).toEqual({
      fragments: [],
      staged: [],
      snapshot: {},
    });
    expect(resolveContextForTurn({
      pageUrl: " ",
      pageTitle: null,
      pageLocale: undefined,
      browserLocale: "",
      content: "\n",
    })).toEqual({
      fragments: [],
      staged: [],
      snapshot: {},
    });
  });
});
