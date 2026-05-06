import { createHash } from "node:crypto";

import bcrypt from "bcryptjs";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { createEnterpriseAuthRoutes } from "./enterpriseAuthRoutes.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

class FakeEnterpriseAuthDatabase implements UsageLimitDatabasePort {
  readonly queries: Array<{ text: string; params: unknown[] }> = [];
  userExists = true;
  readonly userId = "00000000-0000-0000-0000-000000000001";
  readonly accountId = "00000000-0000-0000-0000-000000000002";
  readonly workspaceId = "00000000-0000-0000-0000-000000000003";
  readonly token = "valid-token";
  emailVerifiedAt: Date | null = new Date();
  passwordHash = bcrypt.hashSync("correct-password", 12);

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

const createApp = (database: FakeEnterpriseAuthDatabase) => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ee/auth", createEnterpriseAuthRoutes({ connectorDb: database }));
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
    delete process.env.SESSION_COOKIE_NAME;
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

  it("blocks Enterprise login until signup email verification completes", async () => {
    process.env.EE_MAIL_DRIVER = "noop";
    const database = new FakeEnterpriseAuthDatabase();
    database.emailVerifiedAt = null;

    const response = await request(createApp(database))
      .post("/api/v1/ee/auth/login")
      .send({ email: "ada@example.com", password: "correct-password" });

    expect(response.status).toBe(401);
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
    expect(database.queries.some(({ text }) => text.includes("UPDATE users") && text.includes("password_hash"))).toBe(true);
    expect(database.queries.some(({ text }) => text.includes("UPDATE sessions") && text.includes("revoked_at"))).toBe(true);
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO sessions"))).toBe(true);
  });
});
