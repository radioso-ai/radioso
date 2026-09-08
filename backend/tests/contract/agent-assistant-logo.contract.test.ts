import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestToken } from "../support/testApp.js";

// A 1x1 PNG, the smallest thing the upload allow-list accepts.
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("agent assistant logo contract", () => {
  it("serves the logo to an operator while every visitor channel is switched off", async () => {
    const { app } = createTestApp();
    const session = await issueTestToken(app, "agent-logo-no-public-channel@example.com");
    const authorization = `Bearer ${session.token}`;

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", authorization)
      .expect(200);
    const agent = list.body.agents[0];
    expect(agent.surfaceSettings.anonymousChat.enabled).toBe(false);
    expect(agent.surfaceSettings.websiteEmbed.enabled).toBe(false);

    const uploaded = await request(app)
      .post(`/api/v1/agents/${agent.id}/assistant-logo`)
      .set(adminSessionHeaders(session))
      .attach("logo", pngBytes, { filename: "logo.png", contentType: "image/png" })
      .expect(200);
    expect(uploaded.body.logo).toBeTruthy();

    // No launch token exists yet, so a visitor-token URL could not address this logo at all.
    expect(uploaded.body.surfaceSettings.anonymousChat.token).toBeNull();
    expect(uploaded.body.surfaceSettings.websiteEmbed.token).toBeNull();

    const served = await request(app)
      .get(`/api/v1/agents/${agent.id}/assistant-logo`)
      .query({ workspaceId: session.workspaceId })
      .set("Cookie", session.cookie)
      .expect(200);

    expect(served.headers["content-type"]).toContain("image/png");
    expect(served.headers["cache-control"]).toBe("private, max-age=300");
    expect(Buffer.from(served.body)).toEqual(pngBytes);
  });

  it("reports the operator logo URL on the agent settings surface", async () => {
    const { app } = createTestApp();
    const session = await issueTestToken(app, "agent-logo-settings-url@example.com");

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${session.token}`)
      .expect(200);
    const agentId = list.body.agents[0].id as string;

    await request(app)
      .post(`/api/v1/agents/${agentId}/assistant-logo`)
      .set(adminSessionHeaders(session))
      .attach("logo", pngBytes, { filename: "logo.png", contentType: "image/png" })
      .expect(200);

    const settings = await request(app)
      .get("/api/v1/settings/general")
      .set("X-Forwarded-Prefix", "/backend")
      .set(adminSessionHeaders(session))
      .expect(200);

    expect(settings.body.assistantLogoUrl).toMatch(new RegExp(`^/backend/api/v1/agents/${agentId}/assistant-logo`));
    expect(settings.body.assistantLogoUrl).toContain(`workspaceId=${session.workspaceId}`);
  });

  it("returns not found when the agent has no logo", async () => {
    const { app } = createTestApp();
    const session = await issueTestToken(app, "agent-logo-absent@example.com");

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${session.token}`)
      .expect(200);

    await request(app)
      .get(`/api/v1/agents/${list.body.agents[0].id}/assistant-logo`)
      .query({ workspaceId: session.workspaceId })
      .set("Cookie", session.cookie)
      .expect(404);
  });

  it("refuses a workspace the caller does not own", async () => {
    const { app } = createTestApp();
    const session = await issueTestToken(app, "agent-logo-tenancy-owner@example.com");
    const other = await issueTestToken(app, "agent-logo-tenancy-stranger@example.com");

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", `Bearer ${session.token}`)
      .expect(200);
    const agentId = list.body.agents[0].id as string;

    await request(app)
      .post(`/api/v1/agents/${agentId}/assistant-logo`)
      .set(adminSessionHeaders(session))
      .attach("logo", pngBytes, { filename: "logo.png", contentType: "image/png" })
      .expect(200);

    const response = await request(app)
      .get(`/api/v1/agents/${agentId}/assistant-logo`)
      .query({ workspaceId: session.workspaceId })
      .set("Cookie", other.cookie);

    expect(response.status).not.toBe(200);
  });
});
