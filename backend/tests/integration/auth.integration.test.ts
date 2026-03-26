import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";
import { AuthService } from "../../src/modules/auth/services/authService.js";
import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import {
  createAuditService,
  InMemoryAccountRepository,
  InMemoryWorkspaceRepository,
  InMemoryWorkspaceTokenRepository,
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

  it("returns the default workspace and token from registration", async () => {
    const { app } = createTestApp();

    const response = await request(app).post("/api/v1/auth/register").send({
      email: "bootstrap@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(201);
    expect(response.body.workspaceName).toBe("Default");
    expect(response.body.workspaceId).toBeDefined();
    expect(response.body.token).toMatch(/^sk_proj_[a-f0-9]+$/);
  });

  it("returns the same single token on repeated retrieval", async () => {
    const { app } = createTestApp();
    const cookie = (
      await request(app).post("/api/v1/auth/register").send({
        email: "repeat@example.com",
        password: "verysecurepassword",
      })
    ).headers["set-cookie"][0];

    const workspaces = await request(app)
      .get("/api/v1/workspace")
      .set("Cookie", cookie);
    const workspaceId = workspaces.body.workspaces[0].id;

    const first = await request(app)
      .get(`/api/v1/account/workspaces/${workspaceId}/token`)
      .set("Cookie", cookie);
    const second = await request(app)
      .get(`/api/v1/account/workspaces/${workspaceId}/token`)
      .set("Cookie", cookie);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.token).toEqual(second.body.token);
  });

  it("rotates an unreadable stored token instead of failing", async () => {
    const env = createTestEnv();
    const auditService = createAuditService();
    const accountRepository = new InMemoryAccountRepository();
    const sessionRepository = new InMemorySessionRepository();
    const workspaceTokenRepository = new InMemoryWorkspaceTokenRepository();
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspaceService = new WorkspaceService(workspaceRepository, auditService);
    const authService = new AuthService({
      env,
      auditService,
      accountRepository,
      sessionRepository,
      workspaceTokenRepository,
      workspaceService,
    });

    const account = await accountRepository.create({
      email: "rotate@example.com",
      passwordHash: "hash",
    });
    const workspace = await workspaceService.createDefault(account.id);

    await workspaceTokenRepository.save({
      workspaceId: workspace.id,
      accountId: account.id,
      tokenPrefix: "sk_proj_",
      tokenHash: "stale-hash",
      encryptedToken: "not:a:valid-token",
    });

    const result = await authService.getTokenForWorkspace(workspace.id, account.id);

    expect(result.token).toMatch(/^sk_proj_[a-f0-9]+$/);
    expect(auditService.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "auth.token.read",
          eventStatus: "failure",
        }),
        expect.objectContaining({
          eventType: "auth.token.create",
          eventStatus: "success",
        }),
      ]),
    );
  });

  it("does not create a second default workspace for the same account", async () => {
    const auditService = createAuditService();
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspaceService = new WorkspaceService(workspaceRepository, auditService);
    const accountRepository = new InMemoryAccountRepository();
    const account = await accountRepository.create({
      email: "default-workspace@example.com",
      passwordHash: "hash",
    });

    const first = await workspaceService.createDefault(account.id);
    const second = await workspaceService.createDefault(account.id);
    const workspaces = await workspaceRepository.listByAccountId(account.id);

    expect(second.id).toBe(first.id);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.name).toBe("Default");
  });

  it("returns the preferred workspace on login when the account already has multiple workspaces", async () => {
    const { app } = createTestApp();

    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "multi-workspace@example.com",
      password: "verysecurepassword",
    });

    const cookie = registration.headers["set-cookie"]?.[0];
    const created = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", cookie)
      .send({ name: "Research" });

    const preferredToken = await request(app)
      .get(`/api/v1/account/workspaces/${created.body.id}/token`)
      .set("Cookie", cookie);

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "multi-workspace@example.com",
      password: "verysecurepassword",
      preferredWorkspaceId: created.body.id,
    });

    expect(response.status).toBe(200);
    expect(response.body.workspaceId).toBe(created.body.id);
    expect(response.body.workspaceName).toBe("Research");
    expect(response.body.token).toBe(preferredToken.body.token);
  });
});
