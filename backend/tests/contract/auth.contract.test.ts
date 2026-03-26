import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";

describe("auth contract", () => {
  it("registers a user, issues the default workspace token, and sets a session cookie", async () => {
    const { app } = createTestApp();

    const response = await request(app).post("/api/v1/auth/register").send({
      email: "alice@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(201);
    expect(response.body.userId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.body.workspaceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.body.workspaceName).toBe("Default");
    expect(response.body.token).toMatch(/^sk_proj_[a-f0-9]+$/);
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("logs in an existing user, returns the default workspace token, and sets a session cookie", async () => {
    const { app } = createTestApp();

    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "bob@example.com",
      password: "verysecurepassword",
    });

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "bob@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(200);
    expect(response.body.userId).toBeDefined();
    expect(response.body.workspaceId).toBe(registration.body.workspaceId);
    expect(response.body.workspaceName).toBe("Default");
    expect(response.body.token).toBe(registration.body.token);
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("honors a preferred workspace on login when it belongs to the account", async () => {
    const { app } = createTestApp();

    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "preferred@example.com",
      password: "verysecurepassword",
    });

    const cookie = registration.headers["set-cookie"]?.[0];
    const created = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", cookie)
      .send({ name: "Research" });

    const tokenResponse = await request(app)
      .get(`/api/v1/account/workspaces/${created.body.id}/token`)
      .set("Cookie", cookie);

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "preferred@example.com",
      password: "verysecurepassword",
      preferredWorkspaceId: created.body.id,
    });

    expect(response.status).toBe(200);
    expect(response.body.workspaceId).toBe(created.body.id);
    expect(response.body.workspaceName).toBe("Research");
    expect(response.body.token).toBe(tokenResponse.body.token);
  });

  it("returns the active account token for a session-authenticated account", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "token@example.com");

    expect(token).toMatch(/^sk_proj_[a-f0-9]+$/);
  });
});
