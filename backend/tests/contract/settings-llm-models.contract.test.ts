import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("settings llm-models contract", () => {
  it("returns null for every capability when no preferences are set", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "llm-models-default@example.com");

    const response = await request(app)
      .get("/api/v1/settings/llm-models")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ chat: null, rewrite: null, rerank: null });
    expect(response.body.knownModelsByProvider).toMatchObject({
      openai: expect.arrayContaining(["gpt-5-mini", "gpt-5.6-luna"]),
      claude: expect.arrayContaining([
        "claude-sonnet-5",
        "claude-haiku-4-5-20251001",
      ]),
      gemini: expect.arrayContaining([
        "gemini-3.5-flash",
        "gemini-3.1-flash-lite",
        "gemini-3-flash-preview",
        "gemini-flash-latest",
        "gemini-2.5-flash",
      ]),
      "openai-compatible": [],
    });
  });

  it("rejects an unknown model identifier even for a known provider", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "llm-models-unknown-model@example.com");

    const response = await request(app)
      .put("/api/v1/settings/llm-models")
      .set(adminSessionHeaders(session))
      .send({ chat: { provider: "claude", model: "claude-from-the-future" } });

    expect(response.status).toBe(400);
    expect(response.body.error?.message ?? response.body.message).toMatch(/not supported/i);
  });

  it("accepts arbitrary model identifiers for openai-compatible", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "llm-models-compatible@example.com");

    const response = await request(app)
      .put("/api/v1/settings/llm-models")
      .set(adminSessionHeaders(session))
      .send({ chat: { provider: "openai-compatible", model: "vllm/custom-model-v0" } });

    expect(response.status).toBe(200);
    expect(response.body.chat).toEqual({ provider: "openai-compatible", model: "vllm/custom-model-v0" });
  });

  it("stores a chat preference and reports it back", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "llm-models-chat@example.com");

    const put = await request(app)
      .put("/api/v1/settings/llm-models")
      .set(adminSessionHeaders(session))
      .send({ chat: { provider: "claude", model: "claude-sonnet-4-5" } });

    expect(put.status).toBe(200);
    expect(put.body.chat).toEqual({ provider: "claude", model: "claude-sonnet-4-5" });
    expect(put.body.rewrite).toBeNull();
    expect(put.body.rerank).toBeNull();
  });

  it("clears a preference when null is passed", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "llm-models-clear@example.com");

    await request(app)
      .put("/api/v1/settings/llm-models")
      .set(adminSessionHeaders(session))
      .send({ chat: { provider: "claude", model: "claude-sonnet-4-5" } });

    const cleared = await request(app)
      .put("/api/v1/settings/llm-models")
      .set(adminSessionHeaders(session))
      .send({ chat: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body.chat).toBeNull();
  });

  it("merge-updates without clearing fields that were not sent", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "llm-models-merge@example.com");

    await request(app)
      .put("/api/v1/settings/llm-models")
      .set(adminSessionHeaders(session))
      .send({ chat: { provider: "claude", model: "claude-sonnet-4-5" } });

    await request(app)
      .put("/api/v1/settings/llm-models")
      .set(adminSessionHeaders(session))
      .send({ rewrite: { provider: "gemini", model: "gemini-3.5-flash" } });

    const get = await request(app)
      .get("/api/v1/settings/llm-models")
      .set(adminSessionHeaders(session));

    expect(get.body).toMatchObject({
      chat: { provider: "claude", model: "claude-sonnet-4-5" },
      rewrite: { provider: "gemini", model: "gemini-3.5-flash" },
      rerank: null,
    });
  });

  it("rejects unknown providers with a 400", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "llm-models-bad-provider@example.com");

    const response = await request(app)
      .put("/api/v1/settings/llm-models")
      .set(adminSessionHeaders(session))
      .send({ chat: { provider: "bogus", model: "x" } });

    expect(response.status).toBe(400);
  });

  it("requires authentication", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/api/v1/settings/llm-models");
    expect(response.status).toBe(401);
  });
});
