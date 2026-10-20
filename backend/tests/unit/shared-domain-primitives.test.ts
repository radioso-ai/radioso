import { describe, expect, it } from "vitest";

import { localeTagOf, normalizeLocaleTag } from "../../src/shared/domain/locale.js";
import {
  defaultWebsiteEmbedTheme,
  isAllowedWebsiteEmbedOrigin,
  normalizeWebsiteEmbedOrigin,
} from "../../src/shared/domain/websiteEmbed.js";

describe("shared domain primitives", () => {
  it("reads an outside value as a language tag, trimmed, or as none", () => {
    expect(localeTagOf(" pt-BR ")).toBe("pt-BR");
    expect(localeTagOf("it")).toBe("it");
    for (const value of [7, null, undefined, "", "Italian", { tag: "it" }]) {
      expect(localeTagOf(value)).toBeUndefined();
    }
  });

  it("normalizes optional locale tags without depending on settings internals", () => {
    expect(normalizeLocaleTag(undefined)).toBeNull();
    expect(normalizeLocaleTag(" en-US ")).toBe("en-US");
  });

  it("uses the provided field name in locale validation errors", () => {
    expect(() => normalizeLocaleTag(123, "locale")).toThrow("locale must be a string");
    expect(() => normalizeLocaleTag("not-a-locale", "locale")).toThrow("locale must be a valid locale tag");
  });

  it("normalizes website embed origins for shared surface checks", () => {
    expect(normalizeWebsiteEmbedOrigin(" https://example.com/docs ")).toBe("https://example.com");
    expect(normalizeWebsiteEmbedOrigin(" * ")).toBe("*");
    expect(normalizeWebsiteEmbedOrigin("not a url")).toBeNull();
    expect(isAllowedWebsiteEmbedOrigin(["https://example.com"], "https://example.com/docs")).toBe(true);
    expect(isAllowedWebsiteEmbedOrigin(["https://example.com"], "https://evil.example.com")).toBe(false);
  });

  it("keeps the shared website embed theme default stable", () => {
    expect(defaultWebsiteEmbedTheme()).toEqual({
      brand: "#0f172a",
      brandText: "#f8fafc",
      surface: "#ffffff",
      text: "#0f172a",
    });
  });
});
