import { describe, expect, it } from "vitest";

import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  OauthClientError,
  type FetchLike,
} from "../../../src/modules/integrationOauth/public.js";

const okResponse = (payload: unknown): Awaited<ReturnType<FetchLike>> => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

describe("integration OAuth client", () => {
  it("builds a provider-neutral PKCE authorization URL", () => {
    const url = new URL(buildAuthorizationUrl({
      config: {
        authorizationEndpoint: "https://auth.example.com/authorize",
        clientId: "client-1",
        scopes: ["mail.send", "mail.compose"],
      },
      redirectUri: "https://app.example.com/oauth/customer-email-callback",
      state: "state-1",
      codeChallenge: "challenge-1",
    }));

    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/oauth/customer-email-callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("mail.send mail.compose");
  });

  it("exchanges and refreshes tokens without MCP-specific types", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      calls.push(init.body);
      return okResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
    };

    const config = {
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "client-1",
    };

    await expect(exchangeAuthorizationCode({
      config,
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "https://app.example.com/oauth/customer-email-callback",
      fetchImpl,
    })).resolves.toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });

    await expect(refreshAccessToken({
      config,
      tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
      fetchImpl,
    })).resolves.toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });

    expect(calls.some((body) => body.includes("grant_type=authorization_code"))).toBe(true);
    expect(calls.some((body) => body.includes("grant_type=refresh_token"))).toBe(true);
  });

  it("sanitizes token endpoint failures", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error_description: "secret-bearing provider payload" }),
    });

    await expect(refreshAccessToken({
      config: {
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "client-1",
      },
      tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
      fetchImpl,
    })).rejects.toMatchObject({
      name: "OauthClientError",
      code: "refresh_failed",
      message: "Token refresh failed",
    } satisfies Partial<OauthClientError>);
  });
});
