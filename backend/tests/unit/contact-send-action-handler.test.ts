import { describe, expect, it, vi } from "vitest";

import {
  ContactSendActionHandler,
  type ContactNotificationMailer,
} from "../../src/modules/chat/services/actions/contactSendActionHandler.js";

const context = { workspaceId: "ws_1", accountId: null, conversationId: "conv_1" };

type SentMessage = Parameters<ContactNotificationMailer["send"]>[0];

const recordingMailer = (): { mailer: ContactNotificationMailer; sent: SentMessage[] } => {
  const sent: SentMessage[] = [];
  return { mailer: { send: async (message) => { sent.push(message); } }, sent };
};

describe("ContactSendActionHandler", () => {
  it("emails the gathered contact request to the resolved recipient, with the visitor email as reply-to", async () => {
    const { mailer, sent } = recordingMailer();
    const handler = new ContactSendActionHandler(mailer, { resolve: async () => "owner@business.example" });

    await handler.handle({
      payload: { name: "Alex", email: "alex@example.com", message: "Please call me about pricing." },
      context,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("owner@business.example");
    expect(sent[0]!.replyTo).toBe("alex@example.com");
    expect(sent[0]!.text).toContain("Alex");
    expect(sent[0]!.text).toContain("alex@example.com");
    expect(sent[0]!.text).toContain("Please call me about pricing.");
  });

  it("no-ops (does not send, does not throw) when no recipient is configured", async () => {
    const { mailer, sent } = recordingMailer();
    const warn = vi.fn();
    const handler = new ContactSendActionHandler(mailer, { resolve: async () => null }, { warn });

    await handler.handle({ payload: { email: "alex@example.com", message: "hi" }, context });

    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("tolerates missing optional payload fields", async () => {
    const { mailer, sent } = recordingMailer();
    const handler = new ContactSendActionHandler(mailer, { resolve: async () => "owner@business.example" });

    await handler.handle({ payload: {}, context });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.replyTo).toBeNull();
  });
});
