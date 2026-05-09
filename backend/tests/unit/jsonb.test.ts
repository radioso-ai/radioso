import { describe, expect, it } from "vitest";

import { sanitizeJsonbString, stringifyJsonb } from "../../src/shared/infra/jsonb.js";

describe("jsonb serialization", () => {
  it("replaces characters PostgreSQL jsonb rejects", () => {
    expect(sanitizeJsonbString(`before${String.fromCharCode(0)}after`)).toBe("before\uFFFDafter");
    expect(sanitizeJsonbString(`before${String.fromCharCode(0xd800)}after`)).toBe("before\uFFFDafter");
    expect(sanitizeJsonbString(`before${String.fromCharCode(0xdc00)}after`)).toBe("before\uFFFDafter");
  });

  it("preserves valid surrogate pairs", () => {
    expect(sanitizeJsonbString("hello 😄")).toBe("hello 😄");
  });

  it("serializes nested metadata with jsonb-safe strings", () => {
    const value = {
      trace: {
        outputs: {
          answerPreview: `bad ${String.fromCharCode(0xd800)} preview`,
        },
      },
    };

    expect(stringifyJsonb(value)).toBe('{"trace":{"outputs":{"answerPreview":"bad \uFFFD preview"}}}');
  });
});
