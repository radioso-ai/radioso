import { describe, expect, it } from "vitest";

import { deriveLexicalAlternatives } from "../../src/modules/retrieval/domain/lexicalQueryPlan.js";

describe("lexical query plan normalization", () => {
  it("splits top-level OR alternatives while preserving quoted phrases", () => {
    expect(deriveLexicalAlternatives('"forgot password" OR "reset token" OR SSO')).toEqual([
      "forgot password",
      "reset token",
      "SSO",
    ]);
  });

  it("deduplicates, trims, and caps alternatives", () => {
    expect(
      deriveLexicalAlternatives(' "Reset Token" OR reset token OR email link OR magic link OR backup code ', {
        maxAlternatives: 3,
      }),
    ).toEqual(["Reset Token", "email link", "magic link"]);
  });

  it("keeps ordinary lexical text as one fallback alternative", () => {
    expect(deriveLexicalAlternatives("password reset token")).toEqual(["password reset token"]);
  });

  it("drops alternatives without searchable content", () => {
    expect(deriveLexicalAlternatives('"..." OR "---" OR reset')).toEqual(["reset"]);
  });
});
