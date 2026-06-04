import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  ConfiguredContactDeliveryResolver,
  ContactSendActionHandler,
  WorkspaceOwnerContactRecipientResolver,
  type ContactNotificationMailer,
  type ContactWebhookHttpClient,
} from "../../src/modules/chat/services/actions/contactSendActionHandler.js";

const context = {
  requestId: "request_1",
  workspaceId: "ws_1",
  accountId: null,
  conversationId: "conv_1",
  idempotencyKey: "routine-action:conv_1:contact.send:hash",
  attempt: 1,
};

type SentMessage = Parameters<ContactNotificationMailer["send"]>[0];
type WebhookRequest = Parameters<ContactWebhookHttpClient["postJson"]>[0];

const recordingMailer = (): { mailer: ContactNotificationMailer; sent: SentMessage[] } => {
  const sent: SentMessage[] = [];
  return { mailer: { send: async (message) => { sent.push(message); } }, sent };
};

const recordingWebhookClient = (): { httpClient: ContactWebhookHttpClient; requests: WebhookRequest[] } => {
  const requests: WebhookRequest[] = [];
  return {
    httpClient: {
      postJson: async (request) => {
        requests.push(request);
      },
    },
    requests,
  };
};

describe("ContactSendActionHandler", () => {
  it("emails the gathered contact request to the resolved recipient, with the visitor email as reply-to", async () => {
    const { mailer, sent } = recordingMailer();
    const handler = new ContactSendActionHandler(mailer, {
      resolve: async () => ({ emails: ["owner@business.example"], webhook: null }),
    });

    await handler.handle({
      payload: { name: "Alex", email: "alex@example.com", message: "Please call me about pricing." },
      context,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("owner@business.example");
    expect(sent[0]!.replyTo).toBe("alex@example.com");
    expect(sent[0]!.idempotencyKey).toBe("routine-action:conv_1:contact.send:hash:email:owner%40business.example");
    expect(sent[0]!.text).toContain("Alex");
    expect(sent[0]!.text).toContain("alex@example.com");
    expect(sent[0]!.text).toContain("Please call me about pricing.");
  });

  it("fans out email delivery to every resolved recipient with per-address idempotency", async () => {
    const { mailer, sent } = recordingMailer();
    const handler = new ContactSendActionHandler(mailer, {
      resolve: async () => ({ emails: ["owner@business.example", "sales@business.example"], webhook: null }),
    });

    await handler.handle({
      payload: { name: "Alex", email: "alex@example.com", message: "Please call me about pricing." },
      context,
    });

    expect(sent.map((message) => message.to)).toEqual(["owner@business.example", "sales@business.example"]);
    expect(sent.map((message) => message.idempotencyKey)).toEqual([
      "routine-action:conv_1:contact.send:hash:email:owner%40business.example",
      "routine-action:conv_1:contact.send:hash:email:sales%40business.example",
    ]);
  });

  it("posts configured webhooks with conversation metadata and a valid signature", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const signingKey = Buffer.from("derived-signing-key");
    const handler = new ContactSendActionHandler(
      mailer,
      {
        resolve: async () => ({
          emails: [],
          webhook: { url: "https://hooks.example.com/contact" },
        }),
      },
      undefined,
      httpClient,
      { sign: (body) => createHmac("sha256", signingKey).update(body).digest("base64url") },
    );

    await handler.handle({
      payload: { name: "Alex", email: "alex@example.com", message: "Please call me about pricing." },
      context,
    });

    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://hooks.example.com/contact");
    expect(requests[0]!.idempotencyKey).toBe("routine-action:conv_1:contact.send:hash:webhook");
    expect(requests[0]!.body).toEqual({
      name: "Alex",
      email: "alex@example.com",
      message: "Please call me about pricing.",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      requestId: "request_1",
    });
    const rawBody = JSON.stringify(requests[0]!.body);
    expect(requests[0]!.headers["X-Radioso-Signature"]).toBe(
      createHmac("sha256", signingKey).update(rawBody).digest("base64url"),
    );
    expect(requests[0]!.headers["X-Radioso-Timestamp"]).toMatch(/^\d+$/);
  });

  it("delivers email and webhook together when both are configured", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const handler = new ContactSendActionHandler(
      mailer,
      {
        resolve: async () => ({
          emails: ["owner@business.example"],
          webhook: { url: "https://hooks.example.com/contact" },
        }),
      },
      undefined,
      httpClient,
      { sign: () => "signature" },
    );

    await handler.handle({ payload: { email: "alex@example.com", message: "hi" }, context });

    expect(sent).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("no-ops (does not send, does not throw) when no recipient is configured", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const warn = vi.fn();
    const handler = new ContactSendActionHandler(
      mailer,
      { resolve: async () => ({ emails: [], webhook: null }) },
      { warn },
      httpClient,
      { sign: () => "signature" },
    );

    await handler.handle({ payload: { email: "alex@example.com", message: "hi" }, context });

    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("tolerates missing optional payload fields", async () => {
    const { mailer, sent } = recordingMailer();
    const handler = new ContactSendActionHandler(mailer, {
      resolve: async () => ({ emails: ["owner@business.example"], webhook: null }),
    });

    await handler.handle({ payload: {}, context });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.replyTo).toBeNull();
  });
});

describe("WorkspaceOwnerContactRecipientResolver", () => {
  const resolver = (members: { role: string; email: string }[]) =>
    new WorkspaceOwnerContactRecipientResolver(
      { findById: async () => ({ accountId: "acc_1" }) },
      { listActiveByAccount: async () => members },
    );

  it("resolves the workspace owner's email", async () => {
    const result = await resolver([
      { role: "member", email: "m@x.com" },
      { role: "owner", email: "owner@x.com" },
    ]).resolve({ ...context, workspaceId: "ws_1", conversationId: "c" });
    expect(result).toEqual({ emails: ["owner@x.com"], webhook: null });
  });

  it("falls back to an admin when there is no owner", async () => {
    const result = await resolver([
      { role: "member", email: "m@x.com" },
      { role: "admin", email: "admin@x.com" },
    ]).resolve({ ...context, workspaceId: "ws_1", conversationId: "c" });
    expect(result).toEqual({ emails: ["admin@x.com"], webhook: null });
  });

  it("returns null when no workspaceId, no workspace, or no owner/admin", async () => {
    expect(
      await resolver([]).resolve({ ...context, workspaceId: null, conversationId: "c" }),
    ).toEqual({ emails: [], webhook: null });
    expect(
      await new WorkspaceOwnerContactRecipientResolver(
        { findById: async () => null },
        { listActiveByAccount: async () => [] },
      ).resolve({ ...context, workspaceId: "ws_1", conversationId: "c" }),
    ).toEqual({ emails: [], webhook: null });
    expect(
      await resolver([{ role: "member", email: "m@x.com" }]).resolve({
        ...context,
        workspaceId: "ws_1",
        conversationId: "c",
      }),
    ).toEqual({ emails: [], webhook: null });
  });
});

describe("ConfiguredContactDeliveryResolver", () => {
  it("uses configured agent recipient emails and passes through webhook settings", async () => {
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }) },
      {
        findByIdAndWorkspaceId: async () => ({
          contactRequestDelivery: {
            recipientEmails: ["sales@example.com"],
            webhook: { url: "https://hooks.example.com/contact" },
          },
        }),
      },
      { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) },
    );

    await expect(resolver.resolve(context)).resolves.toEqual({
      emails: ["sales@example.com"],
      webhook: { url: "https://hooks.example.com/contact" },
    });
  });

  it("falls back to workspace owner delivery when no recipient emails are configured", async () => {
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }) },
      {
        findByIdAndWorkspaceId: async () => ({
          contactRequestDelivery: {
            recipientEmails: [],
            webhook: null,
          },
        }),
      },
      { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) },
    );

    await expect(resolver.resolve(context)).resolves.toEqual({
      emails: ["owner@example.com"],
      webhook: null,
    });
  });
});
