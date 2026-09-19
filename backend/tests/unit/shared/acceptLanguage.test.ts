import { describe, expect, it } from "vitest";

import { primaryLanguageTag } from "../../../src/shared/domain/acceptLanguage.js";

describe("primaryLanguageTag", () => {
  it("parses the primary subtag of a multi-value Accept-Language header", () => {
    expect(primaryLanguageTag("de-DE,de;q=0.9")).toBe("de");
  });

  it("parses a single simple tag", () => {
    expect(primaryLanguageTag("fr")).toBe("fr");
  });

  it("lower-cases the primary subtag", () => {
    expect(primaryLanguageTag("EN-us")).toBe("en");
  });

  it("returns null for null, undefined, or empty input", () => {
    expect(primaryLanguageTag(null)).toBeNull();
    expect(primaryLanguageTag(undefined)).toBeNull();
    expect(primaryLanguageTag("")).toBeNull();
    expect(primaryLanguageTag("   ")).toBeNull();
  });

  it("returns null for a malformed header", () => {
    expect(primaryLanguageTag(";;;")).toBeNull();
    expect(primaryLanguageTag(",")).toBeNull();
    expect(primaryLanguageTag("*")).toBeNull();
  });
});
