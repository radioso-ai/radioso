import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

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
});
