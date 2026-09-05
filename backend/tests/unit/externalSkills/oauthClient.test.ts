import { afterEach, describe, expect, it, vi } from "vitest";

import { mcpConnectionInputSchema } from "../../../src/modules/externalSkills/domain.js";
import {
  __setOauthClock,
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  isAccessTokenExpired,
  OauthClientError,
  refreshAccessToken,
  type FetchLike,
} from "../../../src/modules/externalSkills/oauth/oauthClient.js";

afterEach(() => {
  __setOauthClock(() => Date.now());
});

describe("mcpConnectionInputSchema oauth", () => {
  it("requires oauth config when authMethod is oauth", () => {
    const result = mcpConnectionInputSchema.safeParse({
      displayName: "Scheduler",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid oauth config and rejects non-https endpoints", () => {
    const ok = mcpConnectionInputSchema.safeParse({
      displayName: "Scheduler",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth",
      oauth: {
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "client-123",
        clientSecret: "shh",
        scopes: ["read", "write"],
      },
    });
    expect(ok.success).toBe(true);

    const bad = mcpConnectionInputSchema.safeParse({
      displayName: "Scheduler",
      serverUrl: "https://mcp.example.com",
      authMethod: "oauth",
      oauth: {
        authorizationEndpoint: "http://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "client-123",
      },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects oauth config on an access_token connection", () => {
    const result = mcpConnectionInputSchema.safeParse({
      displayName: "Slack",
      serverUrl: "https://mcp.example.com",
      authMethod: "access_token",
      accessToken: "tok",
      oauth: {
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "client-123",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("buildAuthorizationUrl", () => {
  it("builds a PKCE S256 consent URL with scopes", () => {
    const { codeChallenge } = createPkcePair();
    const url = new URL(
      buildAuthorizationUrl({
        config: {
          authorizationEndpoint: "https://auth.example.com/authorize",
          clientId: "client-123",
          scopes: ["read", "write"],
        },
        redirectUri: "https://app.example.com/oauth/callback",
        state: "state-xyz",
        codeChallenge,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/oauth/callback");
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("code_challenge")).toBe(codeChallenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("read write");
  });
});

const okResponse = (body: unknown): ReturnType<FetchLike> =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });

describe("exchangeAuthorizationCode", () => {
  it("posts the code with PKCE verifier and parses tokens", async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      okResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" }),
    );
    __setOauthClock(() => 1_000_000);

    const tokens = await exchangeAuthorizationCode({
      config: {
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "client-123",
        clientSecret: "shh",
      },
      code: "auth-code",
      codeVerifier: "verifier",
      redirectUri: "https://app.example.com/oauth/callback",
      fetchImpl,
    });

    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 1_000_000 + 3600 * 1000,
      tokenType: "Bearer",
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toMatch(/^Basic /);
    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier");
  });

  it("sends client_id in the body for public (no-secret) clients", async () => {
    const fetchImpl = vi.fn<FetchLike>(() => okResponse({ access_token: "at-1" }));
    await exchangeAuthorizationCode({
      config: {
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "client-123",
      },
      code: "c",
      codeVerifier: "v",
      redirectUri: "https://app.example.com/oauth/callback",
      fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
    expect(new URLSearchParams(init.body).get("client_id")).toBe("client-123");
  });

  it("maps a token-endpoint error to a sanitized OauthClientError", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "invalid_grant", secret: "leak" }) });
    await expect(
      exchangeAuthorizationCode({
        config: {
          authorizationEndpoint: "https://auth.example.com/authorize",
          tokenEndpoint: "https://auth.example.com/token",
          clientId: "client-123",
        },
        code: "c",
        codeVerifier: "v",
        redirectUri: "https://app.example.com/oauth/callback",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "token_exchange_failed" });
  });
});

describe("refreshAccessToken", () => {
  it("refreshes and preserves the existing refresh token when none returned", async () => {
    __setOauthClock(() => 5_000_000);
    const fetchImpl = vi.fn<FetchLike>(() => okResponse({ access_token: "at-2", expires_in: 100 }));
    const tokens = await refreshAccessToken({
      config: {
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "client-123",
      },
      tokens: { accessToken: "at-1", refreshToken: "rt-1" },
      fetchImpl,
    });
    expect(tokens.accessToken).toBe("at-2");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.expiresAt).toBe(5_000_000 + 100 * 1000);
  });

  it("fails when there is no refresh token", async () => {
    await expect(
      refreshAccessToken({
        config: {
          authorizationEndpoint: "https://auth.example.com/authorize",
          tokenEndpoint: "https://auth.example.com/token",
          clientId: "client-123",
        },
        tokens: { accessToken: "at-1" },
        fetchImpl: () => okResponse({ access_token: "x" }),
      }),
    ).rejects.toBeInstanceOf(OauthClientError);
  });
});

describe("isAccessTokenExpired", () => {
  it("treats tokens within the skew window as expired and ones with no expiry as valid", () => {
    __setOauthClock(() => 1_000_000);
    expect(isAccessTokenExpired({ accessToken: "a", expiresAt: 1_000_000 + 30_000 })).toBe(true); // within 60s skew
    expect(isAccessTokenExpired({ accessToken: "a", expiresAt: 1_000_000 + 120_000 })).toBe(false);
    expect(isAccessTokenExpired({ accessToken: "a" })).toBe(false);
  });
});
