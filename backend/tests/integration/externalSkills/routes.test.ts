import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../../support/testApp.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const setup = async () => {
  const { app } = createTestApp();
  const session = await issueTestSession(app, `ext-skills-${Math.floor(performance.now())}@example.com`);
  const headers = adminSessionHeaders(session);
  const agent = await request(app).post("/api/v1/agents").set(headers).send({ name: "Bot" });
  expect(agent.status).toBe(201);
  return { app, headers, agentId: agent.body.id as string };
};

describe("external skills routes", () => {
  it("requires authentication", async () => {
    const { app } = createTestApp();
    await request(app).get(`/api/v1/agents/${NIL_UUID}/mcp-connections`).expect(401);
  });

  it("creates a connection (no secret leaked), discovers tools, and defines a skill", async () => {
    const { app, headers, agentId } = await setup();

    const created = await request(app)
      .post(`/api/v1/agents/${agentId}/mcp-connections`)
      .set(headers)
      .send({
        displayName: "Slack",
        serverUrl: "https://mcp.example.com",
        authMethod: "access_token",
        accessToken: "xoxb-secret-token",
      });
    expect(created.status).toBe(201);
    expect(created.body.hasCredential).toBe(true);
    expect(created.body.status).toBe("authorized");
    expect(JSON.stringify(created.body)).not.toContain("xoxb-secret-token");
    const connectionId = created.body.id as string;

    const list = await request(app).get(`/api/v1/agents/${agentId}/mcp-connections`).set(headers).expect(200);
    expect(list.body.connections.some((c: { id: string }) => c.id === connectionId)).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain("xoxb-secret-token");

    const discover = await request(app)
      .post(`/api/v1/agents/${agentId}/mcp-connections/${connectionId}/discover`)
      .set(headers)
      .expect(200);
    expect(discover.body.tools.map((t: { name: string }) => t.name)).toContain("post_message");

    const skill = await request(app)
      .post(`/api/v1/agents/${agentId}/external-skills`)
      .set(headers)
      .send({
        skillName: "handoff_slack",
        connectionId,
        toolName: "post_message",
        boundParams: { channel: "#support" },
        exposedParams: { message: {} },
      });
    expect(skill.status).toBe(201);
    expect(skill.body).toMatchObject({ skillName: "handoff_slack", toolName: "post_message" });

    const skills = await request(app).get(`/api/v1/agents/${agentId}/external-skills`).set(headers).expect(200);
    expect(skills.body.skills.some((s: { skillName: string }) => s.skillName === "handoff_slack")).toBe(true);
  });

  it("rejects an invalid connection body (non-https)", async () => {
    const { app, headers, agentId } = await setup();
    await request(app)
      .post(`/api/v1/agents/${agentId}/mcp-connections`)
      .set(headers)
      .send({ displayName: "X", serverUrl: "http://insecure.example", authMethod: "access_token", accessToken: "t" })
      .expect(400);
  });

  it("rejects a skill bound to a tool the server does not expose", async () => {
    const { app, headers, agentId } = await setup();
    const connection = await request(app)
      .post(`/api/v1/agents/${agentId}/mcp-connections`)
      .set(headers)
      .send({ displayName: "Slack", serverUrl: "https://mcp.example.com", authMethod: "access_token", accessToken: "tok" });

    await request(app)
      .post(`/api/v1/agents/${agentId}/external-skills`)
      .set(headers)
      .send({ skillName: "bad", connectionId: connection.body.id, toolName: "nope", boundParams: {}, exposedParams: {} })
      .expect(400);
  });

  it("returns 400 for a malformed connection id", async () => {
    const { app, headers, agentId } = await setup();
    await request(app).delete(`/api/v1/agents/${agentId}/mcp-connections/not-a-uuid`).set(headers).expect(400);
  });

  it("blocks deleting a referenced connection (409), then allows it once the skill is removed", async () => {
    const { app, headers, agentId } = await setup();
    const conn = await request(app)
      .post(`/api/v1/agents/${agentId}/mcp-connections`)
      .set(headers)
      .send({ displayName: "Slack", serverUrl: "https://mcp.example.com", authMethod: "access_token", accessToken: "tok" });
    const connectionId = conn.body.id as string;
    const skill = await request(app)
      .post(`/api/v1/agents/${agentId}/external-skills`)
      .set(headers)
      .send({ skillName: "ref", connectionId, toolName: "post_message", boundParams: { channel: "#x" }, exposedParams: { message: {} } });
    expect(skill.status).toBe(201);

    await request(app).delete(`/api/v1/agents/${agentId}/mcp-connections/${connectionId}`).set(headers).expect(409);
    await request(app).delete(`/api/v1/agents/${agentId}/external-skills/${skill.body.id}`).set(headers).expect(204);
    await request(app).delete(`/api/v1/agents/${agentId}/mcp-connections/${connectionId}`).set(headers).expect(204);
  });

  it("gets and updates a connection (rename) and a skill (disable)", async () => {
    const { app, headers, agentId } = await setup();
    const conn = await request(app)
      .post(`/api/v1/agents/${agentId}/mcp-connections`)
      .set(headers)
      .send({ displayName: "Slack", serverUrl: "https://mcp.example.com", authMethod: "access_token", accessToken: "xoxb-create-secret" });
    const connectionId = conn.body.id as string;

    const got = await request(app).get(`/api/v1/agents/${agentId}/mcp-connections/${connectionId}`).set(headers).expect(200);
    expect(got.body.displayName).toBe("Slack");

    const renamed = await request(app)
      .patch(`/api/v1/agents/${agentId}/mcp-connections/${connectionId}`)
      .set(headers)
      .send({ displayName: "Slack Prod" })
      .expect(200);
    expect(renamed.body.displayName).toBe("Slack Prod");
    expect(JSON.stringify(renamed.body)).not.toContain("xoxb-create-secret");

    const skill = await request(app)
      .post(`/api/v1/agents/${agentId}/external-skills`)
      .set(headers)
      .send({ skillName: "upd_skill", connectionId, toolName: "post_message", boundParams: { channel: "#x" }, exposedParams: { message: {} } });
    const skillId = skill.body.id as string;

    const gotSkill = await request(app).get(`/api/v1/agents/${agentId}/external-skills/${skillId}`).set(headers).expect(200);
    expect(gotSkill.body.skillName).toBe("upd_skill");

    const disabled = await request(app)
      .patch(`/api/v1/agents/${agentId}/external-skills/${skillId}`)
      .set(headers)
      .send({ enabled: false })
      .expect(200);
    expect(disabled.body.enabled).toBe(false);
  });
});
