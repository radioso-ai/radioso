import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationModuleRegistrationContext, ApplicationRouteMount } from "../radiosoModuleTypes.js";
import {
  createGoogleLoginApplicationModule,
  resolveGoogleLoginConfig,
  resolveGoogleLoginSuccessRedirect,
} from "./applicationModule.js";

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

describe("createGoogleLoginApplicationModule", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // Mounts the module the way the host does at boot: register, then build the
  // router with the dependencies OSS hands every route mount.
  const mountRouter = (dependencies: {
    APP_BASE_URL?: string;
    info: () => void;
    warn?: () => void;
    federatedLogin?: () => Promise<unknown>;
  }) => {
    let mount: ApplicationRouteMount | undefined;
    createGoogleLoginApplicationModule().register?.({
      registerRouteMount: (registered: ApplicationRouteMount) => {
        mount = registered;
      },
    } as unknown as ApplicationModuleRegistrationContext);
    if (!mount) {
      throw new Error("Expected the module to register a route mount");
    }
    const router = mount.createRouter({
      env: { APP_BASE_URL: dependencies.APP_BASE_URL },
      logger: { info: dependencies.info, warn: dependencies.warn ?? vi.fn() },
      authService: { federatedLogin: dependencies.federatedLogin ?? vi.fn() },
      auditService: { record: vi.fn() },
      abuseControlService: { enforce: vi.fn() },
    } as unknown as Parameters<ApplicationRouteMount["createRouter"]>[0]);
    const app = express();
    app.use(mount.path, router);
    return app;
  };

  it("names the missing credentials at boot when the sign-in stays disabled", () => {
    vi.stubEnv("GOOGLE_LOGIN_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_LOGIN_CLIENT_SECRET", "");
    vi.stubEnv("GOOGLE_LOGIN_REDIRECT_URI", "");
    const info = vi.fn();

    mountRouter({ APP_BASE_URL: "https://app.example.com", info });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ missing: ["GOOGLE_LOGIN_CLIENT_ID", "GOOGLE_LOGIN_CLIENT_SECRET"] }),
      expect.stringContaining("disabled"),
    );
  });

  it("names the redirect inputs when no app base URL is configured", () => {
    vi.stubEnv("GOOGLE_LOGIN_CLIENT_ID", "client");
    vi.stubEnv("GOOGLE_LOGIN_CLIENT_SECRET", "secret");
    vi.stubEnv("GOOGLE_LOGIN_REDIRECT_URI", "");
    const info = vi.fn();

    mountRouter({ info });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ missing: ["GOOGLE_LOGIN_REDIRECT_URI or APP_BASE_URL"] }),
      expect.any(String),
    );
  });

  // The boot line proves the logger arrives; this proves it is handed to the
  // router, which is where a failed sign-in's error would otherwise vanish.
  it("hands the host logger to the router so a failed sign-in is reported", async () => {
    vi.stubEnv("GOOGLE_LOGIN_CLIENT_ID", "client");
    vi.stubEnv("GOOGLE_LOGIN_CLIENT_SECRET", "secret");
    vi.stubEnv("GOOGLE_LOGIN_REDIRECT_URI", "https://app.example.com/api/v1/ee/auth/google/callback");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return {
        ok: true,
        status: 200,
        json: async () => (url.includes("token")
          ? { access_token: "access-token" }
          : { sub: "google-sub", email: "person@example.com", email_verified: true }),
      } as unknown as Response;
    }));
    const warn = vi.fn();

    const app = mountRouter({
      APP_BASE_URL: "https://app.example.com",
      info: vi.fn(),
      warn,
      federatedLogin: async () => {
        throw new Error("database unavailable");
      },
    });

    await request(app)
      .get("/api/v1/ee/auth/google/callback?code=auth-code&state=fixed-state")
      .set("Cookie", "radioso_google_login_state=fixed-state");

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: "database unavailable" }) }),
      expect.any(String),
    );
  });

  it("stays quiet once the sign-in is configured", () => {
    vi.stubEnv("GOOGLE_LOGIN_CLIENT_ID", "client");
    vi.stubEnv("GOOGLE_LOGIN_CLIENT_SECRET", "secret");
    vi.stubEnv("GOOGLE_LOGIN_REDIRECT_URI", "");
    const info = vi.fn();

    mountRouter({ APP_BASE_URL: "https://app.example.com", info });

    expect(info).not.toHaveBeenCalled();
  });
});
