import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const extractState = (authorizationUrl: string): string => {
  const parsed = new URL(authorizationUrl);
  const state = parsed.searchParams.get("state");
  if (!state) {
    throw new Error("authorizationUrl did not include state");
  }
  return state;
};

describe("Slack skills contract", () => {
  it("creates, lists, gets, updates, deletes, and validates agent Slack skill definitions", async () => {
    const { app } = createTestApp({
      envOverrides: {
        APP_BASE_URL: "https://app.test.example.com",
        SLACK_OAUTH_CLIENT_ID: "test-slack-client",
        SLACK_OAUTH_CLIENT_SECRET: "test-slack-secret",
        SLACK_SIGNING_SECRET: "test-signing-secret",
      },
    });
    const session = await issueTestSession(app, "slack-skills@example.com");
    const headers = adminSessionHeaders(session);
    const agentList = await request(app).get("/api/v1/agents").set(headers);
    expect(agentList.status).toBe(200);
    const agentId = agentList.body.agents[0].id as string;
    const slackBase = `/api/v1/workspaces/${session.workspaceId}/slack`;

    const started = await request(app).post(`${slackBase}/install/start`).set(headers).send({});
    expect(started.status).toBe(200);
    const callback = await request(app)
      .get("/api/v1/oauth/callback/slack")
      .query({ code: "slack-code", state: extractState(started.body.authorizationUrl as string) });
    expect(callback.status).toBe(302);

    const status = await request(app).get(`${slackBase}/install/status`).set(headers);
    expect(status.status).toBe(200);
    const installationId = status.body.installationId as string;
    expect(installationId).toEqual(expect.any(String));

    const created = await request(app)
      .post(`/api/v1/agents/${agentId}/slack-skills`)
      .set(headers)
      .send({
        skillName: "post_to_slack",
        installationId,
        boundInputs: { channelId: "CROUTINE" },
        exposedInputs: { text: { slotBinding: "message", required: true } },
        enabled: true,
      });
    expect(created.status).toBe(201);
    expect(created.body.skill).toMatchObject({
      id: expect.any(String),
      skillName: "post_to_slack",
      installationId,
      boundInputs: { channelId: "CROUTINE" },
      exposedInputs: { text: { slotBinding: "message", required: true } },
      enabled: true,
      outcomes: ["enqueued", "missing_input", "failed"],
    });

    const listed = await request(app).get(`/api/v1/agents/${agentId}/slack-skills`).set(headers);
    expect(listed.status).toBe(200);
    expect(listed.body.skills).toEqual([
      expect.objectContaining({ id: created.body.skill.id, skillName: "post_to_slack" }),
    ]);

    const fetched = await request(app).get(`/api/v1/agents/${agentId}/slack-skills/${created.body.skill.id}`).set(headers);
    expect(fetched.status).toBe(200);
    expect(fetched.body.skill.id).toBe(created.body.skill.id);

    const duplicate = await request(app)
      .post(`/api/v1/agents/${agentId}/slack-skills`)
      .set(headers)
      .send({
        skillName: "post_to_slack",
        installationId,
        boundInputs: {},
        exposedInputs: { channelId: { slotBinding: "channel" }, text: { slotBinding: "message" } },
      });
    expect(duplicate.status).toBe(409);

    const updated = await request(app)
      .patch(`/api/v1/agents/${agentId}/slack-skills/${created.body.skill.id}`)
      .set(headers)
      .send({
        enabled: false,
        boundInputs: {},
        exposedInputs: { channelId: { slotBinding: "channel" }, text: { slotBinding: "message" } },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.skill).toMatchObject({
      enabled: false,
      boundInputs: {},
      exposedInputs: {
        channelId: { slotBinding: "channel", required: true },
        text: { slotBinding: "message", required: true },
      },
    });

    const invalidOverlap = await request(app)
      .post(`/api/v1/agents/${agentId}/slack-skills`)
      .set(headers)
      .send({
        skillName: "bad_slack_skill",
        installationId,
        boundInputs: { channelId: "CROUTINE" },
        exposedInputs: { channelId: { slotBinding: "channel" }, text: { slotBinding: "message" } },
      });
    expect(invalidOverlap.status).toBe(400);

    const removed = await request(app)
      .delete(`/api/v1/agents/${agentId}/slack-skills/${created.body.skill.id}`)
      .set(headers);
    expect(removed.status).toBe(204);
  });

  it("refuses to disconnect Slack while a skill posts through it, naming the agent and the skill", async () => {
    const { app } = createTestApp({
      envOverrides: {
        APP_BASE_URL: "https://app.test.example.com",
        SLACK_OAUTH_CLIENT_ID: "test-slack-client",
        SLACK_OAUTH_CLIENT_SECRET: "test-slack-secret",
        SLACK_SIGNING_SECRET: "test-signing-secret",
      },
    });
    const session = await issueTestSession(app, "slack-disconnect@example.com");
    const headers = adminSessionHeaders(session);
    const agent = (await request(app).get("/api/v1/agents").set(headers)).body.agents[0] as { id: string; name: string };
    const slackBase = `/api/v1/workspaces/${session.workspaceId}/slack`;
    const started = await request(app).post(`${slackBase}/install/start`).set(headers).send({});
    await request(app)
      .get("/api/v1/oauth/callback/slack")
      .query({ code: "slack-code", state: extractState(started.body.authorizationUrl as string) })
      .expect(302);
    const installationId = (await request(app).get(`${slackBase}/install/status`).set(headers)).body.installationId as string;
    const skill = await request(app)
      .post(`/api/v1/agents/${agent.id}/slack-skills`)
      .set(headers)
      .send({ skillName: "post_to_slack", installationId, boundInputs: { channelId: "CROUTINE" }, exposedInputs: { text: { slotBinding: "message" } } })
      .expect(201);

    const refused = await request(app).delete(`${slackBase}/installation`).set(headers);

    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: "slack_installation_in_use",
      message: `Slack installation is in use. Used by skill "post_to_slack" on agent "${agent.name}". Delete or retarget that skill first.`,
    });

    await request(app).delete(`/api/v1/agents/${agent.id}/slack-skills/${skill.body.skill.id}`).set(headers).expect(204);
    await request(app).delete(`${slackBase}/installation`).set(headers).expect(204);
    expect((await request(app).get(`${slackBase}/install/status`).set(headers)).body.status).toBe("not_configured");
  });
});
