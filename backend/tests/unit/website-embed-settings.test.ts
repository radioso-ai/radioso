import { describe, expect, it } from "vitest";

import {
  coerceWebsiteEmbedSettings,
  defaultWebsiteEmbedSettings,
  isAllowedWebsiteEmbedOrigin,
  validateWebsiteEmbedSettings,
} from "../../src/modules/settings/domain/websiteEmbedSettings.js";

describe("website embed settings", () => {
  it("exposes default website embed settings", () => {
    expect(defaultWebsiteEmbedSettings()).toEqual({
      websiteEmbedEnabled: false,
      websiteEmbedToken: null,
      websiteEmbedAllowedOrigins: [],
      websiteEmbedLauncherLabel: "Chat with us",
      websiteEmbedLauncherPosition: "bottom-right",
      websiteEmbedTheme: {
        brand: "#0f172a",
        brandText: "#f8fafc",
        surface: "#ffffff",
        text: "#0f172a",
      },
      websiteEmbedCopy: {},
      websiteEmbedExpertOverrides: {},
    });
  });

  it("normalizes and deduplicates allowed origins", () => {
    expect(
      validateWebsiteEmbedSettings({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: [
          " https://example.com/path ",
          "https://example.com",
          "https://docs.example.com/help",
        ],
      }),
    ).toMatchObject({
      websiteEmbedEnabled: true,
      websiteEmbedAllowedOrigins: ["https://example.com", "https://docs.example.com"],
    });
  });

  it('preserves "*" as the allow-all origin entry', () => {
    expect(
      validateWebsiteEmbedSettings({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: [" * ", "*"],
      }),
    ).toMatchObject({
      websiteEmbedEnabled: true,
      websiteEmbedAllowedOrigins: ["*"],
    });
  });

  it('round-trips ["*"] as the allow-all origin list', () => {
    expect(
      validateWebsiteEmbedSettings({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["*"],
      }).websiteEmbedAllowedOrigins,
    ).toEqual(["*"]);
  });

  it("preserves an explicitly empty launcher label", () => {
    expect(
      validateWebsiteEmbedSettings({
        websiteEmbedLauncherLabel: "",
      }).websiteEmbedLauncherLabel,
    ).toBe("");
  });

  it("rejects enabling website embed with an empty origin list", () => {
    expect(() =>
      validateWebsiteEmbedSettings({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: [],
      }),
    ).toThrow('At least one allowed origin is required when website embed is enabled (use "*" to allow all)');
  });

  it("allows an empty origin list when website embed is disabled", () => {
    expect(
      validateWebsiteEmbedSettings({
        websiteEmbedEnabled: false,
        websiteEmbedAllowedOrigins: [],
      }),
    ).toMatchObject({ websiteEmbedEnabled: false, websiteEmbedAllowedOrigins: [] });
  });

  it("coerces a stored enabled-but-originless embed to disabled instead of throwing", () => {
    // Read path: legacy/migrated rows can persist enabled=true with no origins.
    // Listing such a workspace must never throw (otherwise org switching 500s).
    expect(() =>
      coerceWebsiteEmbedSettings({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: [],
      }),
    ).not.toThrow();
    expect(
      coerceWebsiteEmbedSettings({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: [],
      }),
    ).toMatchObject({ websiteEmbedEnabled: false, websiteEmbedAllowedOrigins: [] });
  });

  it("preserves a valid stored enabled embed on the read path", () => {
    expect(
      coerceWebsiteEmbedSettings({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com"],
      }),
    ).toMatchObject({
      websiteEmbedEnabled: true,
      websiteEmbedAllowedOrigins: ["https://example.com"],
    });
  });

  it("matches approved origins by normalized origin only", () => {
    expect(isAllowedWebsiteEmbedOrigin(["https://example.com"], "https://example.com/page")).toBe(true);
    expect(isAllowedWebsiteEmbedOrigin(["https://example.com"], "https://other.example.com")).toBe(false);
  });
});
