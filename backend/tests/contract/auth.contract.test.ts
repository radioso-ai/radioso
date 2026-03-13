import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

describe("auth contract", () => {
  it("registers a user and sets a session cookie", async () => {
    const { app } = createTestApp();

    const response = await request(app).post("/api/v1/auth/register").send({
      email: "alice@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(201);
    expect(response.body.userId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.headers["set-cookie"]?.[0]).toContain("hivec_session=");
  });

  it("logs in an existing user and returns a session cookie", async () => {
    const { app } = createTestApp();

    await request(app).post("/api/v1/auth/register").send({
      email: "bob@example.com",
      password: "verysecurepassword",
    });

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "bob@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(200);
    expect(response.body.userId).toBeDefined();
    expect(response.headers["set-cookie"]?.[0]).toContain("hivec_session=");
  });

  it("returns the active account token for a session-authenticated account", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "token@example.com",
      password: "verysecurepassword",
    });

    const response = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      token: expect.stringMatching(/^sk_proj_[a-f0-9]+$/),
    });
  });
});
