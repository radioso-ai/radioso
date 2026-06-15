import { describe, expect, it } from "vitest";

import {
  buildEmailSkillActivityAuditPayload,
  buildEmailSkillActivityRecordInput,
  presentEmailSkillActivity,
} from "../../../src/modules/customerEmail/services/emailSkillActivityPresenter.js";

const secretNeedles = [
  "sk-live-secret",
  "refresh-token-secret",
  "client-secret-value",
  "session-cookie-value",
  "postgres://user:password@example.com/db",
  "This is the full confidential message body",
];

const serialized = (value: unknown) => JSON.stringify(value);

describe("email skill activity redaction", () => {
  it("builds activity records without secrets, credentials, cookies, connection strings, or message bodies", () => {
    const input = buildEmailSkillActivityRecordInput({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      routineId: "routine-1",
      conversationId: "conversation-1",
      skillDefinitionId: "skill-1",
      connectionId: "connection-1",
      skillName: "support_email_customer",
      mode: "send",
      outcome: "provider_rejected",
      providerMessageId: "provider-message-1",
      errorCode: "provider_rejected",
      message: {
        to: "customer@example.com, second.person@sub.example.org",
        cc: "copy@example.net",
        subject: "Token sk-live-secret should not persist",
        bodyText: "This is the full confidential message body with refresh-token-secret",
        bodyHtml: "<p>client-secret-value</p>",
        replyTo: "support@example.com",
      },
    });

    const payload = serialized(input);

    for (const needle of secretNeedles) {
      expect(payload).not.toContain(needle);
    }
    expect(input.recipientSummary).toMatchObject({
      toCount: 2,
      ccCount: 1,
      domains: ["example.com", "example.net", "sub.example.org"],
    });
    expect(input.recipientSummary.redactedRecipients).toEqual([
      "c***@example.com",
      "s***@sub.example.org",
      "c***@example.net",
    ]);
  });

  it("presents and audits only the sanitized activity view", () => {
    const record = {
      id: "activity-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      routineId: "routine-1",
      conversationId: "conversation-1",
      skillDefinitionId: "skill-1",
      connectionId: "connection-1",
      skillName: "support_email_customer",
      mode: "send" as const,
      outcome: "needs_reauth" as const,
      recipientSummary: {
        toCount: 1,
        ccCount: 0,
        domains: ["example.com"],
        redactedRecipients: ["c***@example.com"],
      },
      providerMessageId: null,
      errorCode: "needs_reauth",
      createdAt: new Date("2026-06-15T12:00:00.000Z"),
    };

    const view = presentEmailSkillActivity(record);
    const audit = buildEmailSkillActivityAuditPayload(record);
    const payload = serialized({ view, audit });

    expect(view).toEqual({
      id: "activity-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      routineId: "routine-1",
      conversationId: "conversation-1",
      skillDefinitionId: "skill-1",
      connectionId: "connection-1",
      skillName: "support_email_customer",
      mode: "send",
      outcome: "needs_reauth",
      recipientSummary: {
        toCount: 1,
        ccCount: 0,
        domains: ["example.com"],
        redactedRecipients: ["c***@example.com"],
      },
      providerMessageId: null,
      errorCode: "needs_reauth",
      createdAt: "2026-06-15T12:00:00.000Z",
    });
    for (const needle of secretNeedles) {
      expect(payload).not.toContain(needle);
    }
  });
});
