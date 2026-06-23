import { describe, expect, it, vi } from "vitest";

import { EmailWebhookOperatorNotificationSink } from "../../../src/modules/chat/services/actions/emailWebhookSink.js";
import type {
  ContactNotificationMailer,
  ContactWebhookHttpClient,
} from "../../../src/modules/chat/services/actions/contactSendActionHandler.js";

type SentMessage = Parameters<ContactNotificationMailer["send"]>[0];
type WebhookRequest = Parameters<ContactWebhookHttpClient["post"]>[0];

const notification = {
  kind: "approval" as const,
  workspaceId: "ws_1",
  conversationId: "conv_1",
  agentId: "agent_1",
  handle: "pd_abc",
  dashboardPath: "/conversations/conv_1",
};

const handoffNotification = {
  kind: "handoff" as const,
  workspaceId: "ws_1",
  conversationId: "conv_1",
  agentId: "agent_1",
  reason: "routine_handoff",
  dashboardPath: "/conversations/conv_1",
};

const context = {
  requestId: "request_1",
  workspaceId: "ws_1",
  conversationId: "conv_1",
  idempotencyKey: "routine-action:conv_1:approval.request",
};

const recordingMailer = (): { mailer: ContactNotificationMailer; sent: SentMessage[] } => {
  const sent: SentMessage[] = [];
  return { mailer: { send: async (message) => { sent.push(message); } }, sent };
};

const recordingWebhookClient = (): { httpClient: ContactWebhookHttpClient; requests: WebhookRequest[] } => {
  const requests: WebhookRequest[] = [];
  return {
    httpClient: {
      post: async (request) => {
        requests.push(request);
      },
    },
    requests,
  };
};

describe("EmailWebhookOperatorNotificationSink", () => {
  it("preserves approval email delivery", async () => {
    const { mailer, sent } = recordingMailer();
    const sink = new EmailWebhookOperatorNotificationSink(mailer, {
      resolve: async () => ({ emails: ["owner@business.example"], webhook: null }),
    });

    await sink.deliver(notification, context);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("owner@business.example");
    expect(sent[0]!.subject).toBe("Conversation needs an approval");
    expect(sent[0]!.idempotencyKey).toBe("routine-action:conv_1:approval.request:email:owner%40business.example");
    expect(sent[0]!.text).toContain("Conversation: conv_1");
    expect(sent[0]!.text).toContain("Decision: pd_abc");
    expect(sent[0]!.text).toContain("Open: /conversations/conv_1");
  });

  it("preserves approval webhook delivery", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      {
        resolve: async () => ({
          emails: [],
          webhook: { url: "https://hooks.example.com/approval" },
        }),
      },
      undefined,
      httpClient,
    );

    await sink.deliver(notification, context);

    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://hooks.example.com/approval");
    expect(requests[0]!.headers["Idempotency-Key"]).toBe("routine-action:conv_1:approval.request:webhook");
    expect(JSON.parse(requests[0]!.rawBody)).toEqual({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "agent_1",
      handle: "pd_abc",
      dashboardPath: "/conversations/conv_1",
      requestId: "request_1",
    });
  });

  it("preserves handoff email delivery", async () => {
    const { mailer, sent } = recordingMailer();
    const sink = new EmailWebhookOperatorNotificationSink(mailer, {
      resolve: async () => ({ emails: ["owner@business.example"], webhook: null }),
    });

    await sink.deliver(handoffNotification, {
      ...context,
      idempotencyKey: "routine-action:conv_1:handoff.notify",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("owner@business.example");
    expect(sent[0]!.subject).toBe("Conversation needs a human");
    expect(sent[0]!.idempotencyKey).toBe("routine-action:conv_1:handoff.notify:email:owner%40business.example");
    expect(sent[0]!.text).toContain("Conversation: conv_1");
    expect(sent[0]!.text).toContain("Workspace: ws_1");
    expect(sent[0]!.text).toContain("Agent: agent_1");
    expect(sent[0]!.text).toContain("Reason: routine_handoff");
    expect(sent[0]!.text).toContain("Open: /conversations/conv_1");
  });

  it("preserves handoff webhook delivery", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      {
        resolve: async () => ({
          emails: [],
          webhook: { url: "https://hooks.example.com/handoff" },
        }),
      },
      undefined,
      httpClient,
    );

    await sink.deliver(handoffNotification, {
      ...context,
      idempotencyKey: "routine-action:conv_1:handoff.notify",
    });

    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://hooks.example.com/handoff");
    expect(requests[0]!.headers["Idempotency-Key"]).toBe("routine-action:conv_1:handoff.notify:webhook");
    expect(JSON.parse(requests[0]!.rawBody)).toEqual({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "agent_1",
      reason: "routine_handoff",
      dashboardPath: "/conversations/conv_1",
      requestId: "request_1",
    });
  });

  it("no-ops when no recipient is configured", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const warn = vi.fn();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: [], webhook: null }) },
      { warn },
      httpClient,
    );

    await sink.deliver(notification, context);

    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});
