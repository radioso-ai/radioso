import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createGoogleLoginRouter, type GoogleLoginRouterOptions } from "./googleLoginRoutes.js";
import type { GoogleOAuthConfig } from "./googleOAuthClient.js";

const config: GoogleOAuthConfig = {
  clientId: "client-id",
  clientSecret: "secret",
  redirectUri: "https://app.example.com/api/v1/ee/auth/google/callback",
};

const SUCCESS_REDIRECT = "https://app.example.com/";
const STATE_COOKIE_NAME = "radioso_google_login_state";
const RETURN_TO_COOKIE_NAME = "radioso_google_login_return_to";

const MALICIOUS_RETURN_TARGETS = [
  "https://evil.example.com/x",
  "//evil.example.com/x",
  "/\\evil.example.com",
  "javascript:alert(1)",
  // The URL parser strips ASCII tab, CR and LF before parsing, so each of these
  // inspects as an ordinary path and then resolves to `//host`. A guard that
  // reads raw characters cannot see it; only comparing the resolved origin can.
  "/\t//evil.example.com",
  "/\n//evil.example.com",
  "/\r//evil.example.com",
  "/\t/\\evil.example.com",
  "/\r//evil.example.com/phish?a=1",
  "/\t//user:password@evil.example.com",
];

// Stubs a token exchange and userinfo call that both succeed, so a callback
// can run all the way through to `federatedLogin`.
const createSuccessfulFetch = (): typeof fetch =>
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("token")
      ? { access_token: "access-token" }
      : { sub: "google-sub", email: "person@example.com", email_verified: true, name: "Person" };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;

// Extracts just the `name=value` pair from a Set-Cookie header entry so it
// can be replayed on a follow-up request's Cookie header.
const cookiePair = (setCookieHeader: string[] | undefined, name: string): string => {
  const found = (setCookieHeader ?? []).find((entry) => entry.startsWith(`${name}=`));
  if (!found) {
    throw new Error(`Expected a ${name} cookie in the response`);
  }
  return found.split(";")[0]!;
};

const federatedLoginResult = {
  userId: "user-1",
  accountId: "account-1",
  organizationName: "Org",
  workspaceId: "workspace-1",
  workspaceName: "Workspace",
  workspacePublicRouteKey: "route-key",
  sessionCookie: "radioso_session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax",
};

const createApp = (overrides: Partial<GoogleLoginRouterOptions> = {}) => {
  const app = express();
  const options: GoogleLoginRouterOptions = {
    config,
    successRedirect: SUCCESS_REDIRECT,
    authService: { federatedLogin: vi.fn(async () => federatedLoginResult) },
    generateState: () => "fixed-state",
    ...overrides,
  };
  app.use("/api/v1/ee/auth/google", createGoogleLoginRouter(options));
  return { app, options };
};

describe("google login routes", () => {
  it("reports enabled when configured", async () => {
    const { app } = createApp();
    const response = await request(app).get("/api/v1/ee/auth/google/status");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: true });
  });

  it("reports disabled when not configured", async () => {
    const { app } = createApp({ config: null });
    const response = await request(app).get("/api/v1/ee/auth/google/status");
    expect(response.body).toEqual({ enabled: false });
  });

  it("redirects to Google and sets a state cookie on start", async () => {
    const { app } = createApp();
    const response = await request(app).get("/api/v1/ee/auth/google/start");

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(response.headers.location).toContain("state=fixed-state");
    const setCookie = response.headers["set-cookie"] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith("radioso_google_login_state=fixed-state"))).toBe(true);
  });

  it("keeps a validated same-origin return path through the Google callback", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes("token")
        ? { access_token: "access-token" }
        : { sub: "google-sub", email: "person@example.com", email_verified: true, name: "Person" };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    const { app } = createApp({ fetchImpl });

    const start = await request(app)
      .get("/api/v1/ee/auth/google/start")
      .query({ return_to: "/oauth/operator-mcp/consent?transaction=tx-1" });
    const cookies = start.headers["set-cookie"] as unknown as string[];
    const callback = await request(app)
      .get("/api/v1/ee/auth/google/callback?code=auth-code&state=fixed-state")
      .set("Cookie", cookies);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("https://app.example.com/oauth/operator-mcp/consent?transaction=tx-1");
  });

  it("ignores an external return target", async () => {
    const { app } = createApp();
    const response = await request(app)
      .get("/api/v1/ee/auth/google/start")
      .query({ return_to: "https://attacker.example/steal" });

    const setCookie = response.headers["set-cookie"] as unknown as string[];
    expect(setCookie.some((cookie) => cookie.includes("attacker.example"))).toBe(false);
    expect(setCookie.some((cookie) => cookie.startsWith("radioso_google_login_return_to=;"))).toBe(true);
  });

  it("revalidates a tampered return cookie and keeps the configured fallback", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes("token")
        ? { access_token: "access-token" }
        : { sub: "google-sub", email: "person@example.com", email_verified: true, name: "Person" };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    const successRedirect = "https://app.example.com/dashboard";
    const { app } = createApp({ fetchImpl, successRedirect });

    const response = await request(app)
      .get("/api/v1/ee/auth/google/callback?code=auth-code&state=fixed-state")
      .set("Cookie", [
        "radioso_google_login_state=fixed-state",
        "radioso_google_login_return_to=%2F%2Fattacker.example%2Fsteal",
      ]);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(successRedirect);
  });

  it("returns 404 on start when not configured", async () => {
    const { app } = createApp({ config: null });
    const response = await request(app).get("/api/v1/ee/auth/google/start");
    expect(response.status).toBe(404);
  });

  it("completes the callback, issues a session cookie, and redirects to the app", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes("token")
        ? { access_token: "access-token" }
        : { sub: "google-sub", email: "person@example.com", email_verified: true, name: "Person" };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    const federatedLogin = vi.fn(async () => federatedLoginResult);
    const { app } = createApp({ fetchImpl, authService: { federatedLogin } });

    const response = await request(app)
      .get("/api/v1/ee/auth/google/callback?code=auth-code&state=fixed-state")
      .set("Cookie", "radioso_google_login_state=fixed-state");

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(SUCCESS_REDIRECT);
    expect(federatedLogin).toHaveBeenCalledWith({
      provider: "google",
      subject: "google-sub",
      email: "person@example.com",
      emailVerified: true,
    });
    const setCookie = response.headers["set-cookie"] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith("radioso_session="))).toBe(true);
  });

  it("redirects to the error page and records an audit failure on state mismatch", async () => {
    const record = vi.fn(async () => {});
    const federatedLogin = vi.fn(async () => federatedLoginResult);
    const { app } = createApp({ authService: { federatedLogin }, auditService: { record } });

    const response = await request(app)
      .get("/api/v1/ee/auth/google/callback?code=auth-code&state=attacker-state")
      .set("Cookie", "radioso_google_login_state=fixed-state");

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("error=google_login_failed");
    expect(federatedLogin).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "auth.federated_login", eventStatus: "failure" }),
    );
  });

  it("redirects to the error page when Google returns an error", async () => {
    const { app } = createApp();
    const response = await request(app)
      .get("/api/v1/ee/auth/google/callback?error=access_denied")
      .set("Cookie", "radioso_google_login_state=fixed-state");

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("error=google_login_failed");
  });

  it("redirects to the error page when the OAuth exchange fails", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const federatedLogin = vi.fn(async () => federatedLoginResult);
    const { app } = createApp({ fetchImpl, authService: { federatedLogin } });

    const response = await request(app)
      .get("/api/v1/ee/auth/google/callback?code=auth-code&state=fixed-state")
      .set("Cookie", "radioso_google_login_state=fixed-state");

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("error=google_login_failed");
    expect(federatedLogin).not.toHaveBeenCalled();
  });

  it("stores a same-origin returnTo on start and redirects to it after a successful callback", async () => {
    const federatedLogin = vi.fn(async () => federatedLoginResult);
    const { app } = createApp({ fetchImpl: createSuccessfulFetch(), authService: { federatedLogin } });

    const start = await request(app).get("/api/v1/ee/auth/google/start?returnTo=/invite/abc123");
    const startCookies = start.headers["set-cookie"] as unknown as string[];
    const stateCookie = cookiePair(startCookies, STATE_COOKIE_NAME);
    const returnToCookie = cookiePair(startCookies, RETURN_TO_COOKIE_NAME);

    const callback = await request(app)
      .get("/api/v1/ee/auth/google/callback?code=auth-code&state=fixed-state")
      .set("Cookie", [stateCookie, returnToCookie].join("; "));

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("https://app.example.com/invite/abc123");
  });

  it.each(MALICIOUS_RETURN_TARGETS)(
    "rejects %s as a returnTo value on start and never redirects there from callback",
    async (maliciousReturnTo) => {
      const federatedLogin = vi.fn(async () => federatedLoginResult);
      const { app } = createApp({ fetchImpl: createSuccessfulFetch(), authService: { federatedLogin } });

      const start = await request(app).get(
        `/api/v1/ee/auth/google/start?returnTo=${encodeURIComponent(maliciousReturnTo)}`,
      );
      const startCookies = start.headers["set-cookie"] as unknown as string[];
      const returnToCookie = startCookies.find((entry) => entry.startsWith(`${RETURN_TO_COOKIE_NAME}=`));
      expect(returnToCookie).toMatch(new RegExp(`^${RETURN_TO_COOKIE_NAME}=;`));
      expect(returnToCookie).toContain("Max-Age=0");
      const stateCookie = cookiePair(startCookies, STATE_COOKIE_NAME);

      const callback = await request(app)
        .get("/api/v1/ee/auth/google/callback?code=auth-code&state=fixed-state")
        .set("Cookie", stateCookie);

      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe(SUCCESS_REDIRECT);
    },
  );

  it("falls back to successRedirect when the return cookie is tampered to an off-origin value", async () => {
    const federatedLogin = vi.fn(async () => federatedLoginResult);
    const { app } = createApp({ fetchImpl: createSuccessfulFetch(), authService: { federatedLogin } });

    const tamperedReturnToCookie = `${RETURN_TO_COOKIE_NAME}=${encodeURIComponent("https://evil.example.com/x")}`;

    const callback = await request(app)
      .get("/api/v1/ee/auth/google/callback?code=auth-code&state=fixed-state")
      .set("Cookie", [`${STATE_COOKIE_NAME}=fixed-state`, tamperedReturnToCookie].join("; "));

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(SUCCESS_REDIRECT);
  });

  it("redirects a failed callback back to the stored returnTo path carrying the error param", async () => {
    const { app } = createApp();

    const start = await request(app).get("/api/v1/ee/auth/google/start?returnTo=/invite/xyz");
    const startCookies = start.headers["set-cookie"] as unknown as string[];
    const returnToCookie = cookiePair(startCookies, RETURN_TO_COOKIE_NAME);

    const callback = await request(app)
      .get("/api/v1/ee/auth/google/callback?error=access_denied")
      .set("Cookie", returnToCookie);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("https://app.example.com/invite/xyz?error=google_login_failed");
  });

  it("forwards loginHint to the Google authorization URL when provided", async () => {
    const { app } = createApp();

    const response = await request(app).get(
      "/api/v1/ee/auth/google/start?loginHint=someone%40example.com",
    );

    const location = new URL(response.headers.location);
    expect(location.searchParams.get("login_hint")).toBe("someone@example.com");
  });

  it("omits login_hint from the Google authorization URL when no loginHint is given", async () => {
    const { app } = createApp();

    const response = await request(app).get("/api/v1/ee/auth/google/start");

    const location = new URL(response.headers.location);
    expect(location.searchParams.has("login_hint")).toBe(false);
  });

  it("clears both handshake cookies on every callback outcome", async () => {
    const expectBothCookiesCleared = (setCookieHeader: string[] | undefined) => {
      const cookies = setCookieHeader ?? [];
      expect(
        cookies.some((entry) => entry.startsWith(`${STATE_COOKIE_NAME}=;`) && entry.includes("Max-Age=0")),
      ).toBe(true);
      expect(
        cookies.some((entry) => entry.startsWith(`${RETURN_TO_COOKIE_NAME}=;`) && entry.includes("Max-Age=0")),
      ).toBe(true);
    };

    const success = createApp({ fetchImpl: createSuccessfulFetch() });
    const successResponse = await request(success.app)
      .get("/api/v1/ee/auth/google/callback?code=auth-code&state=fixed-state")
      .set("Cookie", `${STATE_COOKIE_NAME}=fixed-state`);
    expectBothCookiesCleared(successResponse.headers["set-cookie"] as unknown as string[]);

    const providerError = createApp();
    const providerErrorResponse = await request(providerError.app)
      .get("/api/v1/ee/auth/google/callback?error=access_denied")
      .set("Cookie", `${STATE_COOKIE_NAME}=fixed-state`);
    expectBothCookiesCleared(providerErrorResponse.headers["set-cookie"] as unknown as string[]);

    const invalidState = createApp();
    const invalidStateResponse = await request(invalidState.app)
      .get("/api/v1/ee/auth/google/callback?code=auth-code&state=attacker-state")
      .set("Cookie", `${STATE_COOKIE_NAME}=fixed-state`);
    expectBothCookiesCleared(invalidStateResponse.headers["set-cookie"] as unknown as string[]);

    const exchangeFailure = createApp({
      fetchImpl: vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch,
    });
    const exchangeFailureResponse = await request(exchangeFailure.app)
      .get("/api/v1/ee/auth/google/callback?code=auth-code&state=fixed-state")
      .set("Cookie", `${STATE_COOKIE_NAME}=fixed-state`);
    expectBothCookiesCleared(exchangeFailureResponse.headers["set-cookie"] as unknown as string[]);
  });
});
