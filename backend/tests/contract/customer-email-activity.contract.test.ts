import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("customer email activity contract", () => {
  it("lists sanitized workspace email skill activity", async () => {
    const { app, dependencies } = createTestApp({ envOverrides: { APP_BASE_URL: "https://app.test.example.com" } });
    const session = await issueTestSession(app, "customer-email-activity@example.com");
    const headers = adminSessionHeaders(session);
    const agentList = await request(app).get("/api/v1/agents").set(headers);
    expect(agentList.status).toBe(200);
    const agentId = agentList.body.agents[0].id as string;

    await dependencies.emailSkillActivityRepository.record({
      workspaceId: session.workspaceId,
      agentId,
      routineId: null,
      conversationId: null,
      skillDefinitionId: "88888888-8888-4888-8888-000000000001",
      connectionId: "99999999-9999-4999-8999-000000000001",
      skillName: "support_email_customer",
      mode: "send",
      outcome: "provider_rejected",
      recipientSummary: {
        toCount: 1,
        ccCount: 0,
        domains: ["example.com"],
        redactedRecipients: ["c***@example.com"],
      },
      providerMessageId: null,
      errorCode: "provider_rejected",
    });

    const response = await request(app)
      .get(`/api/v1/workspaces/${session.workspaceId}/email-skill-activity`)
      .query({ outcome: "provider_rejected", limit: "5" })
      .set(headers);

    expect(response.status).toBe(200);
    expect(response.body.activities).toEqual([
      expect.objectContaining({
        workspaceId: session.workspaceId,
        agentId,
        skillName: "support_email_customer",
        mode: "send",
        outcome: "provider_rejected",
        recipientSummary: {
          toCount: 1,
          ccCount: 0,
          domains: ["example.com"],
          redactedRecipients: ["c***@example.com"],
        },
        providerMessageId: null,
        errorCode: "provider_rejected",
      }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain("bodyText");
    expect(JSON.stringify(response.body)).not.toContain("refresh-token");
  });
});
