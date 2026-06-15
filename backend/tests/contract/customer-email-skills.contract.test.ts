import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const extractState = (authorizationUrl: string): string => {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("authorizationUrl did not include state");
  return state;
};

const createAuthorizedEmailConnection = async (app: ReturnType<typeof createTestApp>["app"], session: Awaited<ReturnType<typeof issueTestSession>>) => {
  const headers = adminSessionHeaders(session);
  const oauth = await request(app)
    .post(`/api/v1/workspaces/${session.workspaceId}/oauth-connections`)
    .set(headers)
    .send({
      provider: "google_mail",
      displayName: "Support Gmail",
      requestedScopes: [
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.send",
      ],
    });
  expect(oauth.status).toBe(201);

  const callback = await request(app)
    .get("/api/v1/oauth/callback/google_mail")
    .query({ code: "provider-code", state: extractState(oauth.body.authorizationUrl as string) });
  expect(callback.status).toBe(302);

  const connection = await request(app)
    .post(`/api/v1/workspaces/${session.workspaceId}/email-connections`)
    .set(headers)
    .send({
      oauthConnectionId: oauth.body.connectionId,
      displayName: "Support outbound",
      senderEmail: "support@example.com",
      replyToEmail: "support@example.com",
    });
  expect(connection.status).toBe(201);
  return connection.body.connection.id as string;
};

describe("customer email skills contract", () => {
  it("creates, lists, updates, deletes, and validates agent email skill definitions", async () => {
    const { app } = createTestApp({ envOverrides: { APP_BASE_URL: "https://app.test.example.com" } });
    const session = await issueTestSession(app, "customer-email-skills@example.com");
    const headers = adminSessionHeaders(session);
    const agentList = await request(app).get("/api/v1/agents").set(headers);
    expect(agentList.status).toBe(200);
    const agentId = agentList.body.agents[0].id as string;
    const connectionId = await createAuthorizedEmailConnection(app, session);

    const created = await request(app)
      .post(`/api/v1/agents/${agentId}/email-skills`)
      .set(headers)
      .send({
        skillName: "support_email_customer",
        connectionId,
        mode: "draft",
        boundInputs: {
          replyTo: "support@example.com",
          subject: "Support follow-up",
        },
        exposedInputs: {
          to: { slotBinding: "customerEmail" },
          bodyText: { slotBinding: "emailBody" },
        },
        enabled: true,
      });

    expect(created.status).toBe(201);
    expect(created.body.skill).toMatchObject({
      id: expect.any(String),
      skillName: "support_email_customer",
      connectionId,
      mode: "draft",
      enabled: true,
      outcomes: ["drafted", "sent", "missing_input", "disabled_connection", "needs_reauth", "provider_rejected", "failed"],
    });

    const listed = await request(app).get(`/api/v1/agents/${agentId}/email-skills`).set(headers);
    expect(listed.status).toBe(200);
    expect(listed.body.skills).toEqual([
      expect.objectContaining({ id: created.body.skill.id, skillName: "support_email_customer" }),
    ]);

    const duplicate = await request(app)
      .post(`/api/v1/agents/${agentId}/email-skills`)
      .set(headers)
      .send({
        skillName: "support_email_customer",
        connectionId,
        mode: "draft",
        boundInputs: { to: "customer@example.com", subject: "Subject", bodyText: "Body" },
        exposedInputs: {},
      });
    expect(duplicate.status).toBe(409);

    const blockedDelete = await request(app)
      .delete(`/api/v1/workspaces/${session.workspaceId}/email-connections/${connectionId}`)
      .set(headers);
    expect(blockedDelete.status).toBe(409);

    const updated = await request(app)
      .patch(`/api/v1/agents/${agentId}/email-skills/${created.body.skill.id}`)
      .set(headers)
      .send({
        mode: "send",
        enabled: false,
        boundInputs: {
          subject: "Updated follow-up",
        },
        exposedInputs: {
          to: { slotBinding: "customerEmail" },
          bodyText: { slotBinding: "emailBody" },
        },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.skill).toMatchObject({ mode: "send", enabled: false });

    const invalid = await request(app)
      .post(`/api/v1/agents/${agentId}/email-skills`)
      .set(headers)
      .send({
        skillName: "bad.name",
        connectionId,
        mode: "draft",
        boundInputs: { subject: "Subject" },
        exposedInputs: { to: { slotBinding: "customerEmail" } },
      });
    expect(invalid.status).toBe(400);

    const removed = await request(app)
      .delete(`/api/v1/agents/${agentId}/email-skills/${created.body.skill.id}`)
      .set(headers);
    expect(removed.status).toBe(204);

    const deletedConnection = await request(app)
      .delete(`/api/v1/workspaces/${session.workspaceId}/email-connections/${connectionId}`)
      .set(headers);
    expect(deletedConnection.status).toBe(204);
  });
});
