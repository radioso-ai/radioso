import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("agent chat model override contract", () => {
  it("returns behavior defaults for a freshly-created agent", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "agent-chat-default@example.com");

    const list = await request(app)
      .get("/api/v1/agents")
      .set(adminSessionHeaders(session));

    expect(list.status).toBe(200);
    expect(list.body.agents[0]).toMatchObject({
      chatModelOverride: null,
      assistantLinkUtmEnabled: true,
    });
  });

  it("accepts assistant link UTM behavior on agent update and round-trips it", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "agent-link-utm@example.com");

    const list = await request(app)
      .get("/api/v1/agents")
      .set(adminSessionHeaders(session));
    const agentId = list.body.agents[0].id;

    const updated = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ assistantLinkUtmEnabled: false });

    expect(updated.status).toBe(200);
    expect(updated.body.assistantLinkUtmEnabled).toBe(false);

    const refetched = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session));
    expect(refetched.body.assistantLinkUtmEnabled).toBe(false);
  });

  it("accepts chatModelOverride on agent update and round-trips it", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "agent-chat-set@example.com");

    const list = await request(app)
      .get("/api/v1/agents")
      .set(adminSessionHeaders(session));
    const agentId = list.body.agents[0].id;

    const updated = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ chatModelOverride: { provider: "claude", model: "claude-sonnet-4-5" } });

    expect(updated.status).toBe(200);
    expect(updated.body.chatModelOverride).toEqual({ provider: "claude", model: "claude-sonnet-4-5" });

    const refetched = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session));
    expect(refetched.body.chatModelOverride).toEqual({ provider: "claude", model: "claude-sonnet-4-5" });
  });

  it("clears chatModelOverride when null is sent", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "agent-chat-clear@example.com");

    const list = await request(app)
      .get("/api/v1/agents")
      .set(adminSessionHeaders(session));
    const agentId = list.body.agents[0].id;

    await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ chatModelOverride: { provider: "gemini", model: "gemini-3.5-flash" } });

    const cleared = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ chatModelOverride: null });

    expect(cleared.body.chatModelOverride).toBeNull();
  });

  it("rejects an override missing the model field", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "agent-chat-bad-model@example.com");

    const list = await request(app)
      .get("/api/v1/agents")
      .set(adminSessionHeaders(session));
    const agentId = list.body.agents[0].id;

    const response = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ chatModelOverride: { provider: "claude" } });

    expect(response.status).toBe(400);
  });

  it("rejects an openai override the platform's Azure endpoint has no deployment for", async () => {
    const { app } = createTestApp({
      envOverrides: { AZURE_OPENAI_ENDPOINT: "https://radioso-eu-1.openai.azure.com/openai/v1" },
    });
    const session = await issueTestSession(app, "agent-chat-azure@example.com");
    const list = await request(app)
      .get("/api/v1/agents")
      .set(adminSessionHeaders(session));
    const agentId = list.body.agents[0].id;

    const rejected = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ chatModelOverride: { provider: "openai", model: "gpt-5.4-nano" } });
    const accepted = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(adminSessionHeaders(session))
      .send({ chatModelOverride: { provider: "openai", model: "gpt-5-mini" } });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.message ?? rejected.body.message).toContain("gpt-5-mini");
    expect(accepted.status).toBe(200);
    expect(accepted.body.chatModelOverride).toEqual({ provider: "openai", model: "gpt-5-mini" });
  });
});
