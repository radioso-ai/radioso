import { describe, expect, it } from "vitest";

import { resolveGoogleLoginConfig, resolveGoogleLoginSuccessRedirect } from "./applicationModule.js";

describe("resolveGoogleLoginConfig", () => {
  it("returns null when credentials are missing", () => {
    expect(resolveGoogleLoginConfig({ appBaseUrl: "https://app.example.com", processEnv: {} })).toBeNull();
  });

  it("derives the redirect URI from the app base URL", () => {
    const config = resolveGoogleLoginConfig({
      appBaseUrl: "https://app.example.com/",
      processEnv: {
        GOOGLE_LOGIN_CLIENT_ID: "client",
        GOOGLE_LOGIN_CLIENT_SECRET: "secret",
      },
    });

    expect(config).toEqual({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://app.example.com/api/v1/ee/auth/google/callback",
    });
  });

  it("prefers an explicit redirect URI override", () => {
    const config = resolveGoogleLoginConfig({
      appBaseUrl: "https://app.example.com",
      processEnv: {
        GOOGLE_LOGIN_CLIENT_ID: "client",
        GOOGLE_LOGIN_CLIENT_SECRET: "secret",
        GOOGLE_LOGIN_REDIRECT_URI: "https://login.example.com/cb",
      },
    });

    expect(config?.redirectUri).toBe("https://login.example.com/cb");
  });

  it("returns null when no redirect URI can be determined", () => {
    expect(
      resolveGoogleLoginConfig({
        processEnv: { GOOGLE_LOGIN_CLIENT_ID: "client", GOOGLE_LOGIN_CLIENT_SECRET: "secret" },
      }),
    ).toBeNull();
  });
});

describe("resolveGoogleLoginSuccessRedirect", () => {
  it("falls back to the app base URL then root", () => {
    expect(resolveGoogleLoginSuccessRedirect({ appBaseUrl: "https://app.example.com", processEnv: {} })).toBe(
      "https://app.example.com",
    );
    expect(resolveGoogleLoginSuccessRedirect({ processEnv: {} })).toBe("/");
  });

  it("prefers an explicit override", () => {
    expect(
      resolveGoogleLoginSuccessRedirect({
        appBaseUrl: "https://app.example.com",
        processEnv: { GOOGLE_LOGIN_SUCCESS_REDIRECT: "https://app.example.com/dashboard" },
      }),
    ).toBe("https://app.example.com/dashboard");
  });
});
