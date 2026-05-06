import { createHash } from "node:crypto";

import bcrypt from "bcryptjs";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { createEnterpriseAuthRoutes } from "./enterpriseAuthRoutes.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

class FakeEnterpriseAuthDatabase implements UsageLimitDatabasePort {
  readonly queries: Array<{ text: string; params: unknown[] }> = [];
  userExists = true;
  readonly userId = "00000000-0000-0000-0000-000000000001";
  readonly accountId = "00000000-0000-0000-0000-000000000002";
  readonly preferredAccountId = "00000000-0000-0000-0000-000000000012";
  readonly workspaceId = "00000000-0000-0000-0000-000000000003";
  readonly preferredWorkspaceId = "00000000-0000-0000-0000-000000000013";
  readonly token = "valid-token";
  emailVerifiedAt: Date | null = new Date();
  passwordHash = bcrypt.hashSync("correct-password", 12);
  matchedPreferredAccount = false;
  matchedPreferredWorkspace = false;

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });

    if (text.includes("FROM users") && text.includes("WHERE email")) {
      if (!this.userExists) {
        return [];
      }
      return [{
        id: this.userId,
        email: "ada@example.com",
        password_hash: this.passwordHash,
        email_verified_at: this.emailVerifiedAt,
      }] as T[];
    }

    if (text.includes("FROM users") && text.includes("WHERE id")) {
      return [{
        id: this.userId,
        email: "ada@example.com",
        password_hash: this.passwordHash,
        email_verified_at: this.emailVerifiedAt,
      }] as T[];
    }

    if (text.includes("FROM ee_password_reset_tokens") && text.includes("WHERE token_hash")) {
      return [{
        id: "00000000-0000-0000-0000-000000000004",
        user_id: this.userId,
        token_hash: sha256(this.token),
        expires_at: new Date(Date.now() + 60_000),
        used_at: null,
        created_at: new Date(),
      }] as T[];
    }

    if (text.includes("FROM ee_password_reset_tokens") && text.includes("ORDER BY created_at")) {
      return [{
        id: "00000000-0000-0000-0000-000000000004",
        user_id: this.userId,
        token_hash: sha256(this.token),
        expires_at: new Date(Date.now() + 60_000),
        used_at: null,
        created_at: new Date(),
      }] as T[];
    }

    if (text.includes("FROM account_memberships")) {
      if (params[1] === this.preferredAccountId) {
        this.matchedPreferredAccount = true;
        return [{ account_id: this.preferredAccountId }] as T[];
      }
      if (params[1]) {
        return [] as T[];
      }
      return [{ account_id: this.accountId }] as T[];
    }

    if (text.includes("INSERT INTO workspaces")) {
      return [{
        id: this.workspaceId,
        name: "Default",
        public_route_key: "1234567890",
      }] as T[];
    }

    if (text.includes("FROM workspaces")) {
      if (params[1] === this.preferredWorkspaceId) {
        this.matchedPreferredWorkspace = true;
        return [{
          id: this.preferredWorkspaceId,
          name: "Default",
          public_route_key: "1234567890",
        }] as T[];
      }
      if (params[1]) {
        return [] as T[];
      }
      return [{
        id: this.workspaceId,
        name: "Default",
        public_route_key: "1234567890",
      }] as T[];
    }

    if (text.includes("FROM accounts")) {
      return [{ name: "Ada Organization" }] as T[];
    }

    return [];
  }
}

const createApp = (
  database: FakeEnterpriseAuthDatabase,
  options: {
    abuseControlService?: {
      enforced: Array<{ scope: string; subjectKey: string }>;
      enforce(input: { scope: string; subjectKey: string }): Promise<unknown>;
    };
  } = {},
) => {
  const app = express();
  const abuseControlService = options.abuseControlService ?? {
    enforced: [] as Array<{ scope: string; subjectKey: string }>,
    async enforce(input: { scope: string; subjectKey: string }) {
      this.enforced.push({ scope: input.scope, subjectKey: input.subjectKey });
      return undefined;
    },
  };
  app.use(express.json());
  app.use("/api/v1/ee/auth", createEnterpriseAuthRoutes({
    connectorDb: database,
    env: {
      AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
      AUTH_RATE_LIMIT_MAX_ATTEMPTS: 10,
    },
    abuseControlService,
    auditService: {
      async record() {
        return undefined;
      },
    },
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error && typeof error === "object" && "statusCode" in error) {
      res.status(Number(error.statusCode)).json({ error });
      return;
    }
    res.status(500).json({ error: { message: "internal" } });
  });
  return app;
};

describe("enterprise auth routes", () => {
  afterEach(() => {
    delete process.env.EE_MAIL_DRIVER;
    delete process.env.RESEND_MAIL_API_KEY;
    delete process.env.SESSION_COOKIE_NAME;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts password reset request under the Enterprise auth namespace", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    const database = new FakeEnterpriseAuthDatabase();

    const response = await request(createApp(database))
      .post("/api/v1/ee/auth/password-reset/request")
      .send({ email: "Ada@Example.com" });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true });
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO ee_password_reset_tokens"))).toBe(true);
  });

  it("keeps verified Enterprise users able to log in after an unused password reset request", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    process.env.SESSION_COOKIE_NAME = "radioso_session";
    const database = new FakeEnterpriseAuthDatabase();
    const app = createApp(database);

    const resetResponse = await request(app)
      .post("/api/v1/ee/auth/password-reset/request")
      .send({ email: "Ada@Example.com" });

    const loginResponse = await request(app)
      .post("/api/v1/ee/auth/login")
      .send({ email: "ada@example.com", password: "correct-password" });

    expect(resetResponse.status).toBe(202);
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers["set-cookie"]?.[0]).toContain("radioso_session=");
    expect(loginResponse.body).toMatchObject({
      userId: database.userId,
      accountId: database.accountId,
      workspaceId: database.workspaceId,
    });
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO ee_password_reset_tokens"))).toBe(true);
    expect(database.queries.some(({ text }) =>
      text.includes("UPDATE users") &&
      text.includes("email_verified_at")
    )).toBe(false);
  });

  it("registers Enterprise users without a session and issues verification mail", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    const database = new FakeEnterpriseAuthDatabase();
    database.userExists = false;

    const response = await request(createApp(database))
      .post("/api/v1/ee/auth/register")
      .send({ email: "new@example.com", password: "new-secure-password" });

    expect(response.status).toBe(201);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).toMatchObject({
      organizationName: "New Organization",
      workspaceName: "Default",
      requiresEmailVerification: true,
    });
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO ee_email_verification_tokens"))).toBe(true);
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO sessions"))).toBe(false);
  });

  it("resends verification mail for unverified Enterprise users", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    const database = new FakeEnterpriseAuthDatabase();
    database.emailVerifiedAt = null;

    const response = await request(createApp(database))
      .post("/api/v1/ee/auth/email-verification/resend")
      .send({ email: "Ada@Example.com" });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true });
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO ee_email_verification_tokens"))).toBe(true);
    expect(database.queries.some(({ text }) =>
      text.includes("UPDATE users") &&
      text.includes("email_verified_at")
    )).toBe(false);
  });

  it("accepts verification resend for verified Enterprise users without reopening verification", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    const database = new FakeEnterpriseAuthDatabase();

    const response = await request(createApp(database))
      .post("/api/v1/ee/auth/email-verification/resend")
      .send({ email: "Ada@Example.com" });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true });
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO ee_email_verification_tokens"))).toBe(false);
    expect(database.queries.some(({ text }) =>
      text.includes("UPDATE users") &&
      text.includes("email_verified_at")
    )).toBe(false);
  });

  it("cleans up the user and account when Enterprise verification mail delivery fails", async () => {
    process.env.EE_MAIL_DRIVER = "resend";
    process.env.RESEND_MAIL_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("delivery failed", { status: 500 })));
    const database = new FakeEnterpriseAuthDatabase();
    database.userExists = false;

    const response = await request(createApp(database))
      .post("/api/v1/ee/auth/register")
      .send({ email: "new@example.com", password: "new-secure-password" });

    expect(response.status).toBe(500);
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO users"))).toBe(true);
    expect(database.queries.some(({ text }) => text.includes("DELETE FROM accounts"))).toBe(true);
    expect(database.queries.some(({ text }) => text.includes("DELETE FROM users"))).toBe(true);
  });

  it("rate limits Enterprise auth attempts before doing auth work", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    const database = new FakeEnterpriseAuthDatabase();
    const abuseControlService = {
      enforced: [] as Array<{ scope: string; subjectKey: string }>,
      async enforce(input: { scope: string; subjectKey: string }) {
        this.enforced.push({ scope: input.scope, subjectKey: input.subjectKey });
        throw {
          statusCode: 429,
          code: "too_many_requests",
          message: "Rate limit exceeded",
        };
      },
    };

    const response = await request(createApp(database, { abuseControlService }))
      .post("/api/v1/ee/auth/login")
      .send({ email: "Ada@Example.com", password: "correct-password" });

    expect(response.status).toBe(429);
    expect(abuseControlService.enforced).toEqual([{
      scope: "ee.auth.login",
      subjectKey: "ada@example.com",
    }]);
    expect(database.queries).toHaveLength(0);
  });

  it("rate limits token endpoints by source instead of attacker-controlled token value", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    const database = new FakeEnterpriseAuthDatabase();
    const abuseControlService = {
      enforced: [] as Array<{ scope: string; subjectKey: string }>,
      async enforce(input: { scope: string; subjectKey: string }) {
        this.enforced.push({ scope: input.scope, subjectKey: input.subjectKey });
        return undefined;
      },
    };

    const app = createApp(database, { abuseControlService });
    await request(app)
      .post("/api/v1/ee/auth/password-reset/confirm")
      .send({ token: "first-random-token", password: "new-secure-password" });
    await request(app)
      .post("/api/v1/ee/auth/password-reset/confirm")
      .send({ token: "second-random-token", password: "new-secure-password" });

    expect(abuseControlService.enforced).toEqual([
      {
        scope: "ee.auth.password_reset.confirm",
        subjectKey: expect.any(String),
      },
      {
        scope: "ee.auth.password_reset.confirm",
        subjectKey: expect.any(String),
      },
    ]);
    expect(abuseControlService.enforced[0]?.subjectKey).toBe(abuseControlService.enforced[1]?.subjectKey);
  });

  it("blocks Enterprise login until signup email verification completes", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    const database = new FakeEnterpriseAuthDatabase();
    database.emailVerifiedAt = null;

    const response = await request(createApp(database))
      .post("/api/v1/ee/auth/login")
      .send({ email: "ada@example.com", password: "correct-password" });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("email_verification_required");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO sessions"))).toBe(false);
  });

  it("logs in verified Enterprise users", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    process.env.SESSION_COOKIE_NAME = "radioso_session";
    const database = new FakeEnterpriseAuthDatabase();

    const response = await request(createApp(database))
      .post("/api/v1/ee/auth/login")
      .send({ email: "ada@example.com", password: "correct-password" });

    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
    expect(response.body).toMatchObject({
      userId: database.userId,
      accountId: database.accountId,
      organizationName: "Ada Organization",
      workspaceId: database.workspaceId,
      workspaceName: "Default",
      workspacePublicRouteKey: "1234567890",
    });
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO sessions"))).toBe(true);
  });

  it("honors preferred Enterprise account and workspace when logging in", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    process.env.SESSION_COOKIE_NAME = "radioso_session";
    const database = new FakeEnterpriseAuthDatabase();

    const response = await request(createApp(database))
      .post("/api/v1/ee/auth/login")
      .send({
        email: "ada@example.com",
        password: "correct-password",
        preferredAccountId: database.preferredAccountId,
        preferredWorkspaceId: database.preferredWorkspaceId,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accountId: database.preferredAccountId,
      workspaceId: database.preferredWorkspaceId,
    });
    expect(database.queries.some(({ text, params }) =>
      text.includes("FROM account_memberships") &&
      params[1] === database.preferredAccountId
    )).toBe(true);
    expect(database.queries.some(({ text, params }) =>
      text.includes("FROM workspaces") &&
      params[1] === database.preferredWorkspaceId
    )).toBe(true);
  });

  it("falls back when stored Enterprise account and workspace preferences are stale", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    process.env.SESSION_COOKIE_NAME = "radioso_session";
    const database = new FakeEnterpriseAuthDatabase();

    const response = await request(createApp(database))
      .post("/api/v1/ee/auth/login")
      .send({
        email: "ada@example.com",
        password: "correct-password",
        preferredAccountId: "00000000-0000-0000-0000-000000009999",
        preferredWorkspaceId: "00000000-0000-0000-0000-000000008888",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accountId: database.accountId,
      workspaceId: database.workspaceId,
    });
    expect(database.matchedPreferredAccount).toBe(false);
    expect(database.matchedPreferredWorkspace).toBe(false);
    expect(database.queries.filter(({ text }) => text.includes("FROM account_memberships"))).toHaveLength(2);
    expect(database.queries.filter(({ text }) => text.includes("FROM workspaces"))).toHaveLength(2);
  });

  it("confirms password reset, rotates sessions, and returns login context", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    process.env.SESSION_COOKIE_NAME = "radioso_session";
    const database = new FakeEnterpriseAuthDatabase();

    const response = await request(createApp(database))
      .post("/api/v1/ee/auth/password-reset/confirm")
      .send({ token: database.token, password: "new-secure-password" });

    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
    expect(response.body).toMatchObject({
      userId: database.userId,
      accountId: database.accountId,
      email: "ada@example.com",
      organizationName: "Ada Organization",
      workspaceId: database.workspaceId,
      workspaceName: "Default",
      workspacePublicRouteKey: "1234567890",
    });
    expect(database.queries.some(({ text }) =>
      text.includes("UPDATE users") &&
      text.includes("password_hash") &&
      text.includes("email_verified_at")
    )).toBe(true);
    expect(database.queries.some(({ text }) => text.includes("UPDATE accounts") && text.includes("password_hash"))).toBe(true);
    expect(database.queries.some(({ text }) => text.includes("UPDATE sessions") && text.includes("revoked_at"))).toBe(true);
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO sessions"))).toBe(true);
  });
});
