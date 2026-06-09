import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import type { ApplicationRouteMount, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { createUsageLimitRoutes } from "./usageLimitRoutes.js";

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ee/usage-limits", createUsageLimitRoutes(fakeDatabase));
  return app;
};

const fakeDatabase: UsageLimitDatabasePort = {
  async query() {
    return [];
  },
  async withTransaction(callback) {
    return callback(this);
  },
};

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const createSessionApp = (database: UsageLimitDatabasePort = sessionDatabase) => {
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
  app.use("/api/v1/ee/usage-limits", createUsageLimitRoutes(createDependencies(database)));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const payload = error as { statusCode?: number; code?: string; message?: string };
    res.status(payload.statusCode ?? 500).json({
      error: {
        code: payload.code ?? "internal_error",
        message: payload.message ?? "Internal error",
      },
    });
  });
  return app;
};

const createDependencies = (database: UsageLimitDatabasePort): RouteDependencies => ({
  connectorDb: database,
  env: {
    SESSION_COOKIE_NAME: "radioso_session",
  },
  authService: {
    async authenticateSession(token: string) {
      if (token !== "valid-session") {
        throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
      }
      return {
        accountId: "11111111-1111-1111-1111-111111111111",
        userId: "22222222-2222-2222-2222-222222222222",
        sessionId: "33333333-3333-3333-3333-333333333333",
      };
    },
    async authenticateApiToken() {
      throw new Error("API tokens are not used by account usage routes");
    },
  },
  accountAccessService: {
    async requireActiveMembership() {},
    async requirePermission() {},
  },
  workspaceSessionService: {
    async resolve() {
      throw new Error("Workspace sessions are not used by account usage routes");
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
});

const sessionDatabase: UsageLimitDatabasePort = {
  async query(text: string) {
    if (text.includes("FROM ee_usage_limit_account_assignments a")) {
      return [{
        key: "growth",
        display_name: "Growth",
        monthly_answer_limit: 1000,
        stored_document_limit: 250,
        stored_indexed_byte_limit: 5_000_000,
        monthly_indexed_byte_limit: 2_000_000,
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        updated_at: new Date("2026-01-02T00:00:00.000Z"),
      }];
    }
    if (text.includes("FROM ee_usage_limit_answer_counters")) {
      return [{ used_count: 42 }];
    }
    if (text.includes("SUM(d.content_size_bytes)")) {
      return [{ bytes: "131072" }];
    }
    if (text.includes("FROM ee_usage_limit_monthly_indexed_byte_counters")) {
      return [{ used_bytes: "65536" }];
    }
    if (text.includes("COUNT(*)::text AS count")) {
      return [{ count: "17" }];
    }
    return [];
  },
  async withTransaction(callback) {
    return callback(this);
  },
};

describe("usage limit admin routes", () => {
  afterEach(() => {
    delete process.env.EE_USAGE_ADMIN_TOKEN;
  });

  it("requires EE_USAGE_ADMIN_TOKEN to be configured", async () => {
    const response = await request(createApp())
      .get("/api/v1/ee/usage-limits/profiles")
      .expect(503);

    expect(response.body.error).toEqual(expect.objectContaining({
      code: "service_unavailable",
      details: { missingEnv: "EE_USAGE_ADMIN_TOKEN" },
    }));
  });

  it("rejects requests without the configured bearer token", async () => {
    process.env.EE_USAGE_ADMIN_TOKEN = "secret-admin-token";

    await request(createApp())
      .get("/api/v1/ee/usage-limits/profiles")
      .expect(401);
  });

  it("reads, writes, and deletes organization creation overrides with the admin token", async () => {
    process.env.EE_USAGE_ADMIN_TOKEN = "secret-admin-token";
    const queries: Array<{ text: string; params?: unknown[] }> = [];
    const database: UsageLimitDatabasePort = {
      async query(text: string, params?: unknown[]) {
        queries.push({ text, params });
        if (text.includes("SELECT user_id, monthly_limit")) {
          return [{
            user_id: "22222222-2222-2222-2222-222222222222",
            monthly_limit: 25,
            updated_at: new Date("2026-06-09T00:00:00.000Z"),
          }];
        }
        if (text.includes("INSERT INTO ee_org_creation_overrides")) {
          return [{
            user_id: "22222222-2222-2222-2222-222222222222",
            monthly_limit: null,
            updated_at: new Date("2026-06-10T00:00:00.000Z"),
          }];
        }
        return [];
      },
      async withTransaction(callback) {
        return callback(this);
      },
    };

    const getResponse = await request(createSessionApp(database))
      .get("/api/v1/ee/usage-limits/org-creation/users/22222222-2222-2222-2222-222222222222")
      .set("Authorization", "Bearer secret-admin-token")
      .expect(200);
    expect(getResponse.body.override).toMatchObject({
      userId: "22222222-2222-2222-2222-222222222222",
      monthlyLimit: 25,
      unlimited: false,
    });

    const putResponse = await request(createSessionApp(database))
      .put("/api/v1/ee/usage-limits/org-creation/users/22222222-2222-2222-2222-222222222222")
      .set("Authorization", "Bearer secret-admin-token")
      .send({ monthlyLimit: null })
      .expect(200);
    expect(putResponse.body.override).toMatchObject({
      monthlyLimit: null,
      unlimited: true,
    });

    await request(createSessionApp(database))
      .delete("/api/v1/ee/usage-limits/org-creation/users/22222222-2222-2222-2222-222222222222")
      .set("Authorization", "Bearer secret-admin-token")
      .expect(204);

    expect(queries.some((query) => query.text.includes("DELETE FROM ee_org_creation_overrides"))).toBe(true);
  });
});

describe("usage limit account routes", () => {
  it("returns the signed-in account usage without the admin token", async () => {
    const response = await request(createSessionApp())
      .get("/api/v1/ee/usage-limits/me")
      .set("Cookie", "radioso_session=valid-session")
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      accountId: "11111111-1111-1111-1111-111111111111",
      profile: expect.objectContaining({
        key: "growth",
        displayName: "Growth",
        monthlyAnswerLimit: 1000,
        storedDocumentLimit: 250,
        storedIndexedByteLimit: 5_000_000,
        monthlyIndexedByteLimit: 2_000_000,
      }),
      monthlyAnswers: expect.objectContaining({
        used: 42,
        limit: 1000,
      }),
      storedDocuments: {
        used: 17,
        limit: 250,
      },
      storedIndexedBytes: {
        used: 131_072,
        limit: 5_000_000,
      },
      monthlyIndexedBytes: expect.objectContaining({
        used: 65_536,
        limit: 2_000_000,
      }),
    }));
  });

  it("requires a signed-in account session", async () => {
    await request(createSessionApp())
      .get("/api/v1/ee/usage-limits/me")
      .expect(401);
  });
});
