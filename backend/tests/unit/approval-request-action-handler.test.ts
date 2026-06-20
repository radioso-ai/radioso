import { describe, expect, it, vi } from "vitest";

import { ApprovalRequestActionHandler } from "../../src/modules/chat/services/actions/approvalRequestActionHandler.js";
import type {
  ContactNotificationMailer,
  ContactWebhookHttpClient,
} from "../../src/modules/chat/services/actions/contactSendActionHandler.js";

const context = {
  requestId: "request_1",
  workspaceId: "ws_1",
  accountId: null,
  conversationId: "conv_1",
  idempotencyKey: "routine-action:conv_1:approval.request",
  attempt: 1,
};

type SentMessage = Parameters<ContactNotificationMailer["send"]>[0];
type WebhookRequest = Parameters<ContactWebhookHttpClient["post"]>[0];

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

describe("ApprovalRequestActionHandler", () => {
  it("emails resolved recipients with the decision handle and link", async () => {
    const { mailer, sent } = recordingMailer();
    const handler = new ApprovalRequestActionHandler(mailer, {
      resolve: async () => ({ emails: ["owner@business.example"], webhook: null }),
    });

    await handler.handle({
      payload: {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        agentId: "agent_1",
        handle: "pd_abc",
        dashboardPath: "/conversations/conv_1",
      },
      context,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("owner@business.example");
    expect(sent[0]!.subject).toBe("Conversation needs an approval");
    expect(sent[0]!.idempotencyKey).toBe("routine-action:conv_1:approval.request:email:owner%40business.example");
    expect(sent[0]!.text).toContain("Conversation: conv_1");
    expect(sent[0]!.text).toContain("Decision: pd_abc");
    expect(sent[0]!.text).toContain("Open: /conversations/conv_1");
  });

  it("posts configured webhooks with the decision handle and an idempotency key", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const handler = new ApprovalRequestActionHandler(
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

    await handler.handle({
      payload: {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        agentId: "agent_1",
        handle: "pd_abc",
        dashboardPath: "/conversations/conv_1",
      },
      context,
    });

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

  it("no-ops when no recipient is configured", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const warn = vi.fn();
    const handler = new ApprovalRequestActionHandler(
      mailer,
      { resolve: async () => ({ emails: [], webhook: null }) },
      { warn },
      httpClient,
    );

    await handler.handle({ payload: {}, context });

    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});
