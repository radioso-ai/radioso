import { describe, expect, it } from "vitest";

import { DEFAULT_APP_BASE_URL, appUrl } from "../../../src/shared/domain/appUrl.js";

describe("appUrl", () => {
  it("resolves a path against the configured base URL", () => {
    expect(appUrl("/reset-password", "https://app.radioso.ai").toString())
      .toBe("https://app.radioso.ai/reset-password");
  });

  it("falls back to the local development origin when no base URL is configured", () => {
    expect(appUrl("/verify-email", undefined).toString())
      .toBe(`${DEFAULT_APP_BASE_URL}/verify-email`);
    expect(appUrl("/verify-email", null).toString())
      .toBe(`${DEFAULT_APP_BASE_URL}/verify-email`);
  });

  it("returns a URL so callers can attach query parameters", () => {
    const url = appUrl("/verify-email", "https://app.radioso.ai");
    url.searchParams.set("token", "abc");

    expect(url.toString()).toBe("https://app.radioso.ai/verify-email?token=abc");
  });

  it("keeps a base URL path prefix when resolving a relative path", () => {
    expect(appUrl("invite/token-1", "https://example.com/app/").toString())
      .toBe("https://example.com/app/invite/token-1");
  });
});
