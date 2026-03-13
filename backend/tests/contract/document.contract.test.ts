import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

describe("document contract", () => {
  it("creates a document for a bearer-authenticated account", async () => {
    const { app } = createTestApp();

    const register = await request(app).post("/api/v1/auth/register").send({
      email: "document@example.com",
      password: "verysecurepassword",
    });
    const token = await request(app)
      .get("/api/v1/account/token")
      .set("Cookie", register.headers["set-cookie"][0]);

    const response = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token.body.token}`)
      .send({
        title: "Introduction to Test",
        content: "This is a content to be parsed",
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      documentId: expect.any(String),
      status: "ready",
    });
  });
});
