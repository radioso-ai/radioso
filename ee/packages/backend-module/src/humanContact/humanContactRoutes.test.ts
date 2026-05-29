import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { ApplicationRouteMount, UsageLimitDatabasePort, WorkspaceRoutePermission } from "../radiosoModuleTypes.js";
import { createHumanContactRoutes } from "./humanContactRoutes.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const sessionCookie = "radioso_session=valid-session";

const fakeDatabase: UsageLimitDatabasePort = {
  async query() {
    return [];
  },
};

const settingsResponse = {
  enabled: true,
  configured: true,
  emailEnabled: false,
  defaultEmail: null,
  defaultEmails: [],
  webhookEnabled: false,
  webhookUrl: null,
  signingSecretConfigured: false,
  updatedAt: null,
};

const createDependencies = (input: {
  permissions: WorkspaceRoutePermission[];
  deniedPermissions?: WorkspaceRoutePermission[];
  assertPublicWebsiteUrl?: (url: string) => Promise<void>;
}): RouteDependencies => ({
  connectorDb: fakeDatabase,
  env: {
    SESSION_COOKIE_NAME: "radioso_session",
  },
  abuseControlService: {
    async enforce() {},
  },
  auditService: {
    async record() {},
  },
  authService: {
    async authenticateSession(token: string) {
      if (token !== "valid-session") {
        throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
      }
      return {
        accountId: "account-1",
        userId: "user-1",
        sessionId: "session-1",
      };
    },
    async authenticateApiToken() {
      throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
    },
  },
  accountAccessService: {
    async requireActiveMembership() {},
    async requirePermission(params) {
      input.permissions.push(params.permission);
      if (input.deniedPermissions?.includes(params.permission)) {
        throw { statusCode: 403, code: "forbidden", message: "Forbidden" };
      }
    },
  },
  workspaceSessionService: {
    async resolve() {
      return { accountId: "account-1", workspaceId: "workspace-1" };
    },
  },
  userRepository: {
    async findById() {
      return null;
    },
  },
  workspaceRepository: {
    async findByAnonymousChatToken() {
      return null;
    },
  },
  mailService: {
    async send() {},
  },
  assertPublicWebsiteUrl: input.assertPublicWebsiteUrl ?? (async () => {}),
});

const createApp = (input: {
  deniedPermissions?: WorkspaceRoutePermission[];
  assertPublicWebsiteUrl?: (url: string) => Promise<void>;
} = {}) => {
  const permissions: WorkspaceRoutePermission[] = [];
  const updateSettings = vi.fn(async () => settingsResponse);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const cookieHeader = req.header("cookie") ?? "";
    req.cookies = Object.fromEntries(
      cookieHeader
        .split(";")
        .map((part) => part.trim().split("="))
        .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0])),
    );
    next();
  });
  app.use("/api/v1/ee/contact", createHumanContactRoutes(createDependencies({
    permissions,
    deniedPermissions: input.deniedPermissions,
    assertPublicWebsiteUrl: input.assertPublicWebsiteUrl,
  }), {
    async getSettings() {
      return settingsResponse;
    },
    updateSettings,
    async revealSigningSecret() {
      return { signingSecret: "secret-value-for-tests" };
    },
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const payload = error as { statusCode?: number; code?: string; message?: string };
    res.status(payload.statusCode ?? 500).json({
      error: {
        code: payload.code ?? "internal_error",
        message: payload.message ?? "Internal error",
      },
    });
  });
  return { app, permissions, updateSettings };
};

describe("human contact routes", () => {
  it("uses settings-read for contact settings reads", async () => {
    const { app, permissions } = createApp();

    const response = await request(app)
      .get("/api/v1/ee/contact/settings")
      .set("Cookie", sessionCookie);

    expect(response.status).toBe(200);
    expect(permissions).toEqual(["workspace.settings.read"]);
  });

  it("requires credential-management permission for contact webhook writes and secret reads", async () => {
    const { app, permissions, updateSettings } = createApp({
      deniedPermissions: ["workspace.credentials.manage"],
    });

    const update = await request(app)
      .put("/api/v1/ee/contact/settings")
      .set("Cookie", sessionCookie)
      .send({
        enabled: true,
        webhookEnabled: true,
        webhookUrl: "https://hooks.example.com/radioso",
        signingSecret: "secret-value-for-tests",
      });
    expect(update.status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();

    const secret = await request(app)
      .get("/api/v1/ee/contact/settings/signing-secret")
      .set("Cookie", sessionCookie);
    expect(secret.status).toBe(403);
    expect(permissions).toEqual(["workspace.credentials.manage", "workspace.credentials.manage"]);
  });

  it("validates webhook URLs before persisting contact settings", async () => {
    const { app, updateSettings } = createApp({
      assertPublicWebsiteUrl: async () => {
        throw {
          statusCode: 400,
          code: "bad_request",
          message: "Webhook URL must resolve to a public address",
        };
      },
    });

    const response = await request(app)
      .put("/api/v1/ee/contact/settings")
      .set("Cookie", sessionCookie)
      .send({
        enabled: true,
        webhookEnabled: true,
        webhookUrl: "http://127.0.0.1:8080/hook",
        signingSecret: "secret-value-for-tests",
      });

    expect(response.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
