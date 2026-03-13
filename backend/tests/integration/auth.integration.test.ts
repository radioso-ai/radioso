import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";
import { AuthService } from "../../src/modules/auth/services/authService.js";
import {
  createAuditService,
  InMemoryAccountRepository,
  InMemoryAccountTokenRepository,
  InMemorySessionRepository,
} from "../support/fakes.js";
import { createTestEnv } from "../support/testApp.js";

describe("auth integration", () => {
  it("rejects duplicate registrations", async () => {
    const { app } = createTestApp();

    await request(app).post("/api/v1/auth/register").send({
      email: "duplicate@example.com",
      password: "verysecurepassword",
    });

    const response = await request(app).post("/api/v1/auth/register").send({
      email: "duplicate@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("conflict");
  });

  it("rejects invalid login credentials", async () => {
    const { app } = createTestApp();

    await request(app).post("/api/v1/auth/register").send({
      email: "login@example.com",
      password: "verysecurepassword",
    });

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "login@example.com",
      password: "wrong-password",
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthorized");
  });

  it("returns the same single token on repeated retrieval", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "repeat@example.com",
      password: "verysecurepassword",
    });

    const first = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);
    const second = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.token).toEqual(second.body.token);
  });

  it("rotates an unreadable stored token instead of failing", async () => {
    const env = createTestEnv();
    const auditService = createAuditService();
    const accountRepository = new InMemoryAccountRepository();
    const sessionRepository = new InMemorySessionRepository();
    const accountTokenRepository = new InMemoryAccountTokenRepository();
    const authService = new AuthService({
      env,
      auditService,
      accountRepository,
      sessionRepository,
      accountTokenRepository,
    });

    const account = await accountRepository.create({
      email: "rotate@example.com",
      passwordHash: "hash",
    });

    await accountTokenRepository.save({
      accountId: account.id,
      tokenPrefix: "sk_proj_",
      tokenHash: "stale-hash",
      encryptedToken: "not:a:valid-token",
    });

    const result = await authService.getAccountTokenForAccount(account.id);

    expect(result.token).toMatch(/^sk_proj_[a-f0-9]+$/);
    expect(auditService.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: account.id,
          eventType: "auth.token.read",
          eventStatus: "failure",
        }),
        expect.objectContaining({
          accountId: account.id,
          eventType: "auth.token.create",
          eventStatus: "success",
        }),
      ]),
    );
  });
});
