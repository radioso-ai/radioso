import { describe, expect, it } from "vitest";

import {
  GoogleOAuthError,
  buildGoogleAuthorizationUrl,
  resolveGoogleIdentity,
  type GoogleOAuthConfig,
} from "./googleOAuthClient.js";

const config: GoogleOAuthConfig = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "secret",
  redirectUri: "https://app.example.com/api/v1/ee/auth/google/callback",
};

const jsonResponse = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

// `fetch`'s RequestInfo union includes `Request`, which has no meaningful `toString`;
// read its `.url` explicitly instead of relying on base Object stringification.
const toUrlString = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

describe("buildGoogleAuthorizationUrl", () => {
  it("builds a Google consent URL with the required parameters", () => {
    const url = new URL(buildGoogleAuthorizationUrl({ config, state: "state-123" }));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("state-123");
  });
});

describe("resolveGoogleIdentity", () => {
  it("exchanges the code and returns the verified identity", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = toUrlString(input);
      calls.push(url);
      if (url.includes("token")) {
        return jsonResponse(200, { access_token: "access-token-abc" });
      }
      return jsonResponse(200, {
        sub: "google-sub-1",
        email: "Person@Example.com",
        email_verified: true,
        name: "A Person",
      });
    };

    const identity = await resolveGoogleIdentity({ config, code: "auth-code", fetchImpl });

    expect(identity).toEqual({
      subject: "google-sub-1",
      email: "Person@Example.com",
      emailVerified: true,
    });
    expect(calls[0]).toContain("oauth2.googleapis.com/token");
    expect(calls[1]).toContain("userinfo");
  });

  it("treats a string email_verified of \"true\" as verified", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = toUrlString(input);
      if (url.includes("token")) {
        return jsonResponse(200, { access_token: "t" });
      }
      return jsonResponse(200, { sub: "s", email: "e@example.com", email_verified: "true" });
    };

    const identity = await resolveGoogleIdentity({ config, code: "c", fetchImpl });
    expect(identity.emailVerified).toBe(true);
  });

  it("throws when the token exchange fails", async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: "invalid_grant" })) as unknown as typeof fetch;

    await expect(resolveGoogleIdentity({ config, code: "bad", fetchImpl })).rejects.toMatchObject({
      code: "token_exchange_failed",
    });
  });

  it("throws when userinfo is missing the subject", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = toUrlString(input);
      if (url.includes("token")) {
        return jsonResponse(200, { access_token: "t" });
      }
      return jsonResponse(200, { email: "e@example.com" });
    };

    await expect(resolveGoogleIdentity({ config, code: "c", fetchImpl })).rejects.toBeInstanceOf(GoogleOAuthError);
  });
});
