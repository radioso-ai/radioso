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
});
