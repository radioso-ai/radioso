import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp, issueTestToken } from "../support/testApp.js";

describe("general settings contract", () => {
  it("GET /api/v1/settings/general returns default settings", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app);

    const response = await request(app)
      .get("/api/v1/settings/general")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      anonymousChatEnabled: false,
      anonymousChatUrl: null,
      anonymousRateLimit: 10,
    });
  });

  it("PUT /api/v1/settings/general enables anonymous chat and generates URL", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app);

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set("Authorization", `Bearer ${token}`)
      .send({ anonymousChatEnabled: true });

    expect(response.status).toBe(200);
    expect(response.body.anonymousChatEnabled).toBe(true);
    expect(response.body.anonymousChatUrl).toBeDefined();
    expect(response.body.anonymousChatUrl).toContain("/chat/");
    expect(response.body.anonymousRateLimit).toBe(10);
  });

  it("PUT /api/v1/settings/general updates rate limit", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app);

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set("Authorization", `Bearer ${token}`)
      .send({ anonymousChatEnabled: true, anonymousRateLimit: 20 });

    expect(response.status).toBe(200);
    expect(response.body.anonymousRateLimit).toBe(20);
  });

  it("toggling off preserves token but returns null URL", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app);

    // Enable
    await request(app)
      .put("/api/v1/settings/general")
      .set("Authorization", `Bearer ${token}`)
      .send({ anonymousChatEnabled: true });

    // Disable
    const response = await request(app)
      .put("/api/v1/settings/general")
      .set("Authorization", `Bearer ${token}`)
      .send({ anonymousChatEnabled: false });

    expect(response.status).toBe(200);
    expect(response.body.anonymousChatEnabled).toBe(false);
    expect(response.body.anonymousChatUrl).toBeNull();

    // Re-enable — should reuse same token
    const reEnabled = await request(app)
      .put("/api/v1/settings/general")
      .set("Authorization", `Bearer ${token}`)
      .send({ anonymousChatEnabled: true });

    expect(reEnabled.body.anonymousChatEnabled).toBe(true);
    expect(reEnabled.body.anonymousChatUrl).toBeDefined();
  });

  it("rejects unauthenticated access", async () => {
    const { app } = createTestApp();

    const response = await request(app).get("/api/v1/settings/general");

    expect(response.status).toBe(401);
  });

  it("rejects invalid rate limit", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app);

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set("Authorization", `Bearer ${token}`)
      .send({ anonymousChatEnabled: true, anonymousRateLimit: 100 });

    expect(response.status).toBe(400);
  });
});
