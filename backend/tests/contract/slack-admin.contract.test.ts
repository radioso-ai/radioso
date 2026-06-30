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

const expectNoSecrets = (body: unknown) => {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("xoxb-test-slack-token");
  expect(serialized).not.toContain("test-slack-secret");
  expect(serialized).not.toContain("test-signing-secret");
};

describe("Slack admin REST contract", () => {
  it("reports incomplete Slack readiness and does not start OAuth without the full env set", async () => {
    const { app } = createTestApp({
      envOverrides: {
        APP_BASE_URL: "https://app.test.example.com",
        SLACK_OAUTH_CLIENT_ID: "test-slack-client",
        SLACK_OAUTH_CLIENT_SECRET: "test-slack-secret",
        SLACK_SIGNING_SECRET: undefined,
      },
    });
    const session = await issueTestSession(app, "slack-not-ready@example.com");
    const headers = adminSessionHeaders(session);
    const base = `/api/v1/workspaces/${session.workspaceId}/slack`;

    const status = await request(app).get(`${base}/install/status`).set(headers);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      status: "not_configured",
      readiness: {
        configured: false,
        missingEnvVars: ["SLACK_SIGNING_SECRET"],
      },
    });

    const started = await request(app).post(`${base}/install/start`).set(headers).send({});
    expect(started.status).toBe(503);
    expect(started.body.error.message).toContain("SLACK_SIGNING_SECRET");
  });

  it("returns the self-host Slack manifest with env checklist and no secrets", async () => {
    const { app } = createTestApp({
      envOverrides: {
        APP_BASE_URL: "https://self-host.example.com/",
        SLACK_OAUTH_CLIENT_ID: "test-slack-client",
        SLACK_OAUTH_CLIENT_SECRET: "test-slack-secret",
        SLACK_SIGNING_SECRET: "test-signing-secret",
      },
    });
    const session = await issueTestSession(app, "slack-manifest@example.com");
    const headers = adminSessionHeaders(session);
    const base = `/api/v1/workspaces/${session.workspaceId}/slack`;

    const response = await request(app).get(`${base}/manifest`).set(headers);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      manifest: {
        oauth_config: {
          redirect_urls: ["https://self-host.example.com/api/v1/oauth/callback/slack"],
          scopes: {
            bot: expect.arrayContaining([
              "app_mentions:read",
              "chat:write",
              "im:history",
              "im:read",
              "im:write",
              "reactions:write",
              "users:read",
              "users:read.email",
            ]),
          },
        },
        settings: {
          event_subscriptions: {
            request_url: "https://self-host.example.com/api/connectors/slack/events",
            bot_events: ["app_mention", "message.im"],
          },
          interactivity: {
            is_enabled: true,
            request_url: "https://self-host.example.com/api/connectors/slack/interactivity",
          },
        },
      },
      requiredEnvVars: ["SLACK_OAUTH_CLIENT_ID", "SLACK_OAUTH_CLIENT_SECRET", "SLACK_SIGNING_SECRET"],
    });
    expectNoSecrets(response.body);
  });

  it("builds the Slack manifest from the API origin on split-host deployments", async () => {
    const { app } = createTestApp({
      envOverrides: {
        APP_BASE_URL: "https://app.example.com",
        CONNECTOR_PUBLIC_BASE_URL: "https://api.example.com",
        SLACK_OAUTH_CLIENT_ID: "test-slack-client",
        SLACK_OAUTH_CLIENT_SECRET: "test-slack-secret",
        SLACK_SIGNING_SECRET: "test-signing-secret",
      },
    });
    const session = await issueTestSession(app, "slack-manifest-split@example.com");
    const headers = adminSessionHeaders(session);

    const response = await request(app)
      .get(`/api/v1/workspaces/${session.workspaceId}/slack/manifest`)
      .set(headers);

    expect(response.status).toBe(200);
    expect(response.body.manifest.oauth_config.redirect_urls).toEqual([
      "https://api.example.com/api/v1/oauth/callback/slack",
    ]);
    expect(response.body.manifest.settings.event_subscriptions.request_url).toBe(
      "https://api.example.com/api/connectors/slack/events",
    );
    expect(response.body.manifest.settings.interactivity.request_url).toBe(
      "https://api.example.com/api/connectors/slack/interactivity",
    );
  });

  it("starts install, reports status, manages binding, and disconnects without returning secrets", async () => {
    const { app } = createTestApp({
      envOverrides: {
        APP_BASE_URL: "https://app.test.example.com",
        SLACK_OAUTH_CLIENT_ID: "test-slack-client",
        SLACK_OAUTH_CLIENT_SECRET: "test-slack-secret",
        SLACK_SIGNING_SECRET: "test-signing-secret",
      },
    });
    const session = await issueTestSession(app, "slack-admin@example.com");
    const headers = adminSessionHeaders(session);
    const base = `/api/v1/workspaces/${session.workspaceId}/slack`;
    const agentList = await request(app).get("/api/v1/agents").set(headers);
    expect(agentList.status).toBe(200);
    const answeringAgentId = agentList.body.agents[0].id as string;

    const initialStatus = await request(app).get(`${base}/install/status`).set(headers);
    expect(initialStatus.status).toBe(200);
    expect(initialStatus.body).toEqual({
      status: "not_configured",
      readiness: {
        configured: true,
        missingEnvVars: [],
      },
    });

    const started = await request(app).post(`${base}/install/start`).set(headers).send({});
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      authorizationUrl: expect.stringContaining("https://slack.com/oauth/v2/authorize"),
      connectionId: expect.any(String),
      status: "pending",
    });
    expectNoSecrets(started.body);

    const callback = await request(app)
      .get("/api/v1/oauth/callback/slack")
      .query({ code: "slack-code", state: extractState(started.body.authorizationUrl as string) });
    expect(callback.status).toBe(302);

    const connected = await request(app).get(`${base}/install/status`).set(headers);
    expect(connected.status).toBe(200);
    expect(connected.body).toEqual({
      status: "connected",
      readiness: {
        configured: true,
        missingEnvVars: [],
      },
      installationId: expect.any(String),
      teamName: "Test Slack",
    });
    expectNoSecrets(connected.body);

    const emptyBinding = await request(app).get(`${base}/binding`).set(headers);
    expect(emptyBinding.status).toBe(200);
    expect(emptyBinding.body).toEqual({
      channelId: null,
      answeringAgentId: null,
      escalationChannelId: null,
      gapEscalationEnabled: false,
    });

    const updatedBinding = await request(app)
      .put(`${base}/binding`)
      .set(headers)
      .send({ answeringAgentId, escalationChannelId: "CESCALATE", gapEscalationEnabled: true });
    expect(updatedBinding.status).toBe(200);
    expect(updatedBinding.body).toEqual({
      channelId: null,
      answeringAgentId,
      escalationChannelId: "CESCALATE",
      gapEscalationEnabled: true,
    });
    expectNoSecrets(updatedBinding.body);

    const policyOnlyUpdate = await request(app)
      .put(`${base}/binding`)
      .set(headers)
      .send({ answeringAgentId, gapEscalationEnabled: false });
    expect(policyOnlyUpdate.status).toBe(200);
    expect(policyOnlyUpdate.body).toEqual({
      channelId: null,
      answeringAgentId,
      escalationChannelId: "CESCALATE",
      gapEscalationEnabled: false,
    });

    const channelBinding = await request(app)
      .put(`${base}/binding`)
      .set(headers)
      .send({ channelId: "C_SUPPORT", answeringAgentId });
    expect(channelBinding.status).toBe(200);
    expect(channelBinding.body).toEqual({
      channelId: "C_SUPPORT",
      answeringAgentId,
      escalationChannelId: null,
      gapEscalationEnabled: false,
    });

    const bindings = await request(app).get(`${base}/bindings`).set(headers);
    expect(bindings.status).toBe(200);
    expect(bindings.body).toEqual({
      bindings: [
        {
          channelId: null,
          answeringAgentId,
          escalationChannelId: "CESCALATE",
          gapEscalationEnabled: false,
        },
        {
          channelId: "C_SUPPORT",
          answeringAgentId,
          escalationChannelId: null,
          gapEscalationEnabled: false,
        },
      ],
    });

    const missingDeleteChannel = await request(app).delete(`${base}/binding`).set(headers);
    expect(missingDeleteChannel.status).toBe(400);
    expect(missingDeleteChannel.body.error.message).toBe("channelId is required");

    const deletedChannel = await request(app).delete(`${base}/binding`).query({ channelId: "C_SUPPORT" }).set(headers);
    expect(deletedChannel.status).toBe(204);

    const afterChannelDelete = await request(app).get(`${base}/bindings`).set(headers);
    expect(afterChannelDelete.status).toBe(200);
    expect(afterChannelDelete.body).toEqual({
      bindings: [
        {
          channelId: null,
          answeringAgentId,
          escalationChannelId: "CESCALATE",
          gapEscalationEnabled: false,
        },
      ],
    });

    const connectedWithBinding = await request(app).get(`${base}/install/status`).set(headers);
    expect(connectedWithBinding.status).toBe(200);
    expect(connectedWithBinding.body).toEqual({
      status: "connected",
      readiness: {
        configured: true,
        missingEnvVars: [],
      },
      installationId: expect.any(String),
      teamName: "Test Slack",
      answeringAgentId,
    });

    const disconnected = await request(app).delete(`${base}/installation`).set(headers);
    expect(disconnected.status).toBe(204);

    const finalStatus = await request(app).get(`${base}/install/status`).set(headers);
    expect(finalStatus.status).toBe(200);
    expect(finalStatus.body).toEqual({
      status: "not_configured",
      readiness: {
        configured: true,
        missingEnvVars: [],
      },
    });
  });
});
