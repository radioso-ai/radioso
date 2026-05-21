import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("settings credentials contract", () => {
  it("starts with an empty credential list and reports encryption is configured", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "creds-empty@example.com");

    const response = await request(app)
      .get("/api/v1/settings/credentials")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      encryptionConfigured: true,
      credentials: [],
      envProviderAvailability: {
        openai: expect.any(Boolean),
        "openai-compatible": expect.any(Boolean),
        gemini: expect.any(Boolean),
        claude: expect.any(Boolean),
      },
    });
  });

  it("stores a provider api key without echoing it back", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "creds-store@example.com");

    const put = await request(app)
      .put("/api/v1/settings/credentials/openai")
      .set(adminSessionHeaders(session))
      .send({ apiKey: "sk-test-secret-1234567890" });

    expect(put.status).toBe(204);
    expect(JSON.stringify(put.body)).not.toContain("sk-test-secret");

    const list = await request(app)
      .get("/api/v1/settings/credentials")
      .set(adminSessionHeaders(session));

    expect(list.status).toBe(200);
    expect(list.body.credentials).toHaveLength(1);
    expect(list.body.credentials[0]).toMatchObject({ provider: "openai" });
    expect(list.body.credentials[0]).not.toHaveProperty("apiKey");
    expect(list.body.credentials[0]).not.toHaveProperty("ciphertext");
  });

  it("removes a provider credential", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "creds-remove@example.com");

    await request(app)
      .put("/api/v1/settings/credentials/claude")
      .set(adminSessionHeaders(session))
      .send({ apiKey: "claude-key" });

    const removed = await request(app)
      .delete("/api/v1/settings/credentials/claude")
      .set(adminSessionHeaders(session));
    expect(removed.status).toBe(204);

    const second = await request(app)
      .delete("/api/v1/settings/credentials/claude")
      .set(adminSessionHeaders(session));
    expect(second.status).toBe(404);
  });

  it("rejects empty api keys", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "creds-empty-key@example.com");

    const response = await request(app)
      .put("/api/v1/settings/credentials/gemini")
      .set(adminSessionHeaders(session))
      .send({ apiKey: "" });

    expect(response.status).toBe(400);
  });

  it("rejects unknown providers via the path schema", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "creds-bad-provider@example.com");

    const response = await request(app)
      .put("/api/v1/settings/credentials/bogus")
      .set(adminSessionHeaders(session))
      .send({ apiKey: "key" });

    expect(response.status).toBe(400);
  });

  it("rejects DELETE for an unknown provider with 400 (not 500)", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "creds-bad-provider-delete@example.com");

    const response = await request(app)
      .delete("/api/v1/settings/credentials/bogus")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(400);
  });

  it("requires authentication", async () => {
    const { app } = createTestApp();

    const response = await request(app).get("/api/v1/settings/credentials");

    expect(response.status).toBe(401);
  });
});
