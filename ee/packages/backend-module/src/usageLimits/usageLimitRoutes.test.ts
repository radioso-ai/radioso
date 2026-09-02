import { randomUUID } from "node:crypto";

import express from "express";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ApplicationRouteMount, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { usageLimitMigrator } from "./usageLimitMigrator.js";
import { createUsageLimitRoutes } from "./usageLimitRoutes.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);

// A real `pg.Pool` is required because the route layer now constructs the
// usage-limit service/guard which build a Kysely from `database.pool`. Auth/
// config tests never reach a query, so a pool that points at the integration
// database (or, when unavailable, a never-queried pool) is sufficient for them;
// the data-backed route tests are gated on a reachable database.
class PgDatabase implements UsageLimitDatabasePort {
  constructor(readonly pool: pg.Pool) {}

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query(text, params);
    return result.rows as T[];
  }

  async withTransaction<T>(callback: (client: UsageLimitDatabasePort) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

// Auth/config tests build the router (which eagerly constructs the Kysely-backed
// service) but never execute a query against it, so this pool is never connected.
const inertDatabase = new PgDatabase(
  new pg.Pool({ connectionString: "postgres://unused:unused@127.0.0.1:1/unused" }),
);

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ee/usage-limits", createUsageLimitRoutes(inertDatabase));
  return app;
};

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const createDependencies = (database: UsageLimitDatabasePort): RouteDependencies => ({
  connectorDb: database,
  env: {
    SESSION_COOKIE_NAME: "radioso_session",
  },
  apiPrincipalRouteInventory: {
    markAuthenticator(handler) {
      return handler;
    },
    markRouteMount(router) {
      return router;
    },
  },
  authService: {
    async authenticateSession(token: string) {
      if (token !== "valid-session") {
        throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
      }
      return {
        accountId: sessionAccountId,
        userId: sessionUserId,
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
} as unknown as RouteDependencies);

const createSessionApp = (database: UsageLimitDatabasePort) => {
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

// Stable session identity reused across the data-backed tests so seeded rows and
// the authenticated session line up.
const sessionAccountId = "11111111-1111-1111-1111-111111111111";
const sessionUserId = "22222222-2222-2222-2222-222222222222";

describe("usage limit admin route auth", () => {
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

  it("requires a signed-in account session", async () => {
    await request(createSessionApp(inertDatabase))
      .get("/api/v1/ee/usage-limits/me")
      .expect(401);
  });

  it("marks both account and router-wide admin authentication for the host policy inventory", () => {
    const modes: string[] = [];
    const dependencies = createDependencies(inertDatabase);
    dependencies.apiPrincipalRouteInventory = {
      markAuthenticator(handler, mode) {
        modes.push(mode);
        return handler;
      },
      markRouteMount(router) {
        return router;
      },
    };

    createUsageLimitRoutes(dependencies);

    expect(modes).toEqual(["session_only", "session_only"]);
  });
});

const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

const createBaseSchema = async (database: UsageLimitDatabasePort): Promise<void> => {
  await database.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT 'hash',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Account',
      email TEXT NOT NULL DEFAULT 'a@example.com',
      password_hash TEXT NOT NULL DEFAULT 'hash',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id UUID PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Workspace',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      content_size_bytes BIGINT,
      external_document_id TEXT,
      source_kind TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

describeIfDatabase("usage limit routes (database-backed)", () => {
  let pool: pg.Pool;
  let database: PgDatabase;
  // Isolate in a dedicated schema so the minimal base tables never collide with the full
  // OSS schema in `public` on the shared ci:local test DB.
  const schema = `ee_test_${randomUUID().replace(/-/g, "")}`;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    pool = new pg.Pool({
      connectionString: integrationDatabaseUrl!,
      options: `-c search_path=${schema}`,
    });
    database = new PgDatabase(pool);
    await createBaseSchema(database);
    await usageLimitMigrator.migrate(database);

    await database.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash') ON CONFLICT (id) DO NOTHING`,
      [sessionUserId, `routes-${sessionUserId}@example.com`],
    );
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, 'hash') ON CONFLICT (id) DO NOTHING`,
      [sessionAccountId, "Routes Account", `routes-${sessionAccountId}@example.com`],
    );
  });

  afterEach(() => {
    delete process.env.EE_USAGE_ADMIN_TOKEN;
  });

  afterAll(async () => {
    await pool.end();
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  });

  it("returns the signed-in account usage without the admin token", async () => {
    const workspaceId = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, account_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [workspaceId, sessionAccountId],
    );
    // Assign a profile with concrete limits so serialization is exercised.
    await database.query(
      `INSERT INTO ee_usage_limit_profiles (
         key, display_name, monthly_answer_limit, stored_document_limit,
         stored_indexed_byte_limit, monthly_indexed_byte_limit
       ) VALUES ('growth', 'Growth', 1000, 250, 5000000, 2000000)
       ON CONFLICT (key) DO UPDATE SET
         monthly_answer_limit = EXCLUDED.monthly_answer_limit,
         stored_document_limit = EXCLUDED.stored_document_limit,
         stored_indexed_byte_limit = EXCLUDED.stored_indexed_byte_limit,
         monthly_indexed_byte_limit = EXCLUDED.monthly_indexed_byte_limit`,
    );
    await database.query(
      `INSERT INTO ee_usage_limit_account_assignments (account_id, profile_key)
       VALUES ($1, 'growth')
       ON CONFLICT (account_id) DO UPDATE SET profile_key = EXCLUDED.profile_key`,
      [sessionAccountId],
    );

    const response = await request(createSessionApp(database))
      .get("/api/v1/ee/usage-limits/me")
      .set("Cookie", "radioso_session=valid-session")
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      accountId: sessionAccountId,
      profile: expect.objectContaining({
        key: "growth",
        displayName: "Growth",
        monthlyAnswerLimit: 1000,
        storedDocumentLimit: 250,
        storedIndexedByteLimit: 5_000_000,
        monthlyIndexedByteLimit: 2_000_000,
      }),
      monthlyAnswers: expect.objectContaining({ limit: 1000 }),
      storedDocuments: expect.objectContaining({ limit: 250 }),
      storedIndexedBytes: expect.objectContaining({ limit: 5_000_000 }),
      monthlyIndexedBytes: expect.objectContaining({ limit: 2_000_000 }),
    }));
  });

  it("reads, writes, and deletes organization creation overrides with the admin token", async () => {
    process.env.EE_USAGE_ADMIN_TOKEN = "secret-admin-token";

    const putResponse = await request(createSessionApp(database))
      .put(`/api/v1/ee/usage-limits/org-creation/users/${sessionUserId}`)
      .set("Authorization", "Bearer secret-admin-token")
      .send({ monthlyLimit: 25 })
      .expect(200);
    expect(putResponse.body.override).toMatchObject({
      userId: sessionUserId,
      monthlyLimit: 25,
      unlimited: false,
    });

    const getResponse = await request(createSessionApp(database))
      .get(`/api/v1/ee/usage-limits/org-creation/users/${sessionUserId}`)
      .set("Authorization", "Bearer secret-admin-token")
      .expect(200);
    expect(getResponse.body.override).toMatchObject({
      userId: sessionUserId,
      monthlyLimit: 25,
      unlimited: false,
    });

    const unlimitedResponse = await request(createSessionApp(database))
      .put(`/api/v1/ee/usage-limits/org-creation/users/${sessionUserId}`)
      .set("Authorization", "Bearer secret-admin-token")
      .send({ monthlyLimit: null })
      .expect(200);
    expect(unlimitedResponse.body.override).toMatchObject({
      monthlyLimit: null,
      unlimited: true,
    });

    await request(createSessionApp(database))
      .delete(`/api/v1/ee/usage-limits/org-creation/users/${sessionUserId}`)
      .set("Authorization", "Bearer secret-admin-token")
      .expect(204);

    const rows = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ee_org_creation_overrides WHERE user_id = $1`,
      [sessionUserId],
    );
    expect(rows[0].count).toBe("0");
  });
});
