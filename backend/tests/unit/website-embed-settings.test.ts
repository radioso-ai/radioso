import { describe, expect, it } from "vitest";

import {
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
      websiteEmbedLauncherIcon: "chat",
      websiteEmbedLauncherPosition: "bottom-right",
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

  it("rejects enabling website embed without an allowed origin", () => {
    expect(() =>
      validateWebsiteEmbedSettings({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: [],
      }),
    ).toThrow("At least one allowed origin is required");
  });

  it("matches approved origins by normalized origin only", () => {
    expect(isAllowedWebsiteEmbedOrigin(["https://example.com"], "https://example.com/page")).toBe(true);
    expect(isAllowedWebsiteEmbedOrigin(["https://example.com"], "https://other.example.com")).toBe(false);
  });
});

