import { describe, expect, it, vi } from "vitest";

import {
  EMAIL_SEND_ACTION_TYPE,
  emailSendActionPayloadSchema,
  emailSendKey,
  isEmailSendKeyFor,
  readEmailSendAction,
  type EmailSendActionPayload,
} from "../../src/modules/emailChannel/outbound/emailSendAction.js";
import { DeliveryFailureDecisions } from "../../src/modules/customerReplyDelivery/public.js";
import { EmailCustomerReplyDeliverer, EmailDeliveryFailureResolver } from "../../src/modules/emailChannel/public.js";
import { createInMemoryDeliveryFailures } from "../support/inMemoryDeliveryFailures.js";
import { InMemoryEmailDomains, InMemoryEmailMailboxes } from "../support/inMemoryEmailChannel.js";
import { createSendPathHarness, SEND_IDS } from "../support/inMemoryEmailSend.js";

/** Contract: the `email.send` outbox action, payload version 1, and its key formats (ports §7a). */

const MAILBOX = "33333333-3333-4333-8333-333333333333";
const CONVERSATION = "66666666-6666-4666-8666-666666666666";
const MESSAGE = "77777777-7777-4777-8777-777777777777";
const HELD_REPLY = "88888888-8888-4888-8888-888888888888";
const DOMAIN = "44444444-4444-4444-8444-444444444444";

const authority = { policyVersion: 4, ownershipVersion: 2, mode: "operator_only", domainId: DOMAIN } as const;

const payloads: Record<EmailSendActionPayload["trigger"], EmailSendActionPayload> = {
  operator_reply: { version: 1, trigger: "operator_reply", mailboxId: MAILBOX, conversationId: CONVERSATION, messageId: MESSAGE, heldReplyId: null, authority },
  held_release: { version: 1, trigger: "held_release", mailboxId: MAILBOX, conversationId: CONVERSATION, messageId: MESSAGE, heldReplyId: HELD_REPLY, authority },
  auto_reply: { version: 1, trigger: "auto_reply", mailboxId: MAILBOX, conversationId: CONVERSATION, messageId: null, heldReplyId: HELD_REPLY, authority: { ...authority, mode: "auto" } },
  audited_resend: { version: 1, trigger: "audited_resend", mailboxId: MAILBOX, conversationId: CONVERSATION, messageId: MESSAGE, heldReplyId: null, authority },
};

describe("email.send action contract", () => {
  it("is the email.send action type", () => {
    expect(EMAIL_SEND_ACTION_TYPE).toBe("email.send");
  });

  describe("payload v1", () => {
    it.each(Object.entries(payloads))("accepts the %s shape", (_trigger, payload) => {
      expect(emailSendActionPayloadSchema.parse(payload)).toEqual(payload);
    });

    it("carries ids and authority only: no text, addresses or subject", () => {
      for (const field of ["text", "to", "from", "subject", "replyTo", "html"]) {
        expect(emailSendActionPayloadSchema.safeParse({ ...payloads.operator_reply, [field]: "x" }).success).toBe(false);
      }
      expect(emailSendActionPayloadSchema.safeParse({ ...payloads.operator_reply, authority: { ...authority, address: "x" } }).success).toBe(false);
    });

    it.each([
      ["another version", { version: 2 }],
      ["an unknown trigger", { trigger: "broadcast" }],
      ["a message-less operator reply", { messageId: null }],
      ["a held reply on an operator reply", { heldReplyId: HELD_REPLY }],
      ["a non-uuid mailbox", { mailboxId: "mailbox-1" }],
      ["an unknown mode", { authority: { ...authority, mode: "manual" } }],
      ["a missing authority", { authority: undefined }],
    ])("rejects %s", (_label, patch) => {
      expect(emailSendActionPayloadSchema.safeParse({ ...payloads.operator_reply, ...patch }).success).toBe(false);
    });

    it("requires the held reply on releases and automatic replies, and a message only where one exists", () => {
      expect(emailSendActionPayloadSchema.safeParse({ ...payloads.held_release, heldReplyId: null }).success).toBe(false);
      expect(emailSendActionPayloadSchema.safeParse({ ...payloads.auto_reply, messageId: MESSAGE }).success).toBe(false);
      expect(emailSendActionPayloadSchema.safeParse({ ...payloads.auto_reply, heldReplyId: null }).success).toBe(false);
    });
  });

  describe("key formats", () => {
    it("names the message, the held reply, or the message's numbered resend", () => {
      expect(emailSendKey.message(MESSAGE)).toBe(`email:send:msg:${MESSAGE}`);
      expect(emailSendKey.heldReply(HELD_REPLY)).toBe(`email:send:held:${HELD_REPLY}`);
      expect(emailSendKey.resend(MESSAGE, 2)).toBe(`email:send:msg:${MESSAGE}:resend:2`);
    });

    it.each([
      ["operator_reply", emailSendKey.message(MESSAGE), true],
      ["operator_reply", emailSendKey.heldReply(HELD_REPLY), false],
      ["held_release", emailSendKey.message(MESSAGE), true],
      ["auto_reply", emailSendKey.heldReply(HELD_REPLY), true],
      ["auto_reply", emailSendKey.message(MESSAGE), false],
      ["audited_resend", emailSendKey.resend(MESSAGE, 1), true],
      ["audited_resend", emailSendKey.resend(MESSAGE, 12), true],
      ["audited_resend", emailSendKey.message(MESSAGE), false],
      ["audited_resend", `email:send:msg:${MESSAGE}:resend:0`, false],
      ["audited_resend", emailSendKey.resend(CONVERSATION, 1), false],
    ] as const)("%s accepts %s: %s", (trigger, key, expected) => {
      expect(isEmailSendKeyFor(payloads[trigger], key)).toBe(expected);
    });

    it("refuses a claimed action whose key is not its trigger's", () => {
      expect(() => readEmailSendAction({ ...payloads.operator_reply }, null)).toThrow("email_send_key_mismatch");
      expect(() => readEmailSendAction({ ...payloads.operator_reply }, emailSendKey.resend(MESSAGE, 1))).toThrow("email_send_key_mismatch");
      expect(readEmailSendAction({ ...payloads.operator_reply }, emailSendKey.message(MESSAGE)).payload).toEqual(payloads.operator_reply);
    });
  });

  it("is what an audited resend of an uncertain send queues: exactly one new action, under the resend key", async () => {
    const h = createSendPathHarness();
    await h.deliver();
    h.advance(24 * 60 * 60 * 1000);
    await h.reconciler.run({ maxJobs: 5 });
    const original = h.onlyIntent();
    expect(original.state).toBe("uncertain");

    const store = createInMemoryDeliveryFailures();
    await store.failures.open({
      workspaceId: SEND_IDS.workspace,
      conversationId: SEND_IDS.conversation,
      messageId: SEND_IDS.message,
      provider: "email",
      kind: "uncertain",
      detailCode: null,
    });
    const outbox = { enqueue: vi.fn(async (_request: { type: string; idempotencyKey?: string | null; payload: Record<string, unknown> }) => ({ id: "action-1", duplicate: false })) };
    const decisions = new DeliveryFailureDecisions({
      failures: store.failures,
      resolver: new EmailDeliveryFailureResolver({
        intents: h.intents,
        mailboxes: h.mailboxes,
        domains: h.domains,
        ownership: { versionOf: async () => 0 },
        unitOfWork: { run: (work) => work({ intents: h.intents, failures: store.failures, outbox }) },
      }),
      audit: { record: vi.fn(async () => undefined) },
      logger: { warn: vi.fn() },
    });
    const failureId = store.rows[0].id;
    const actor = { accountId: "account-1", workspaceId: SEND_IDS.workspace, userId: "99999999-0000-4000-8000-000000000001" };

    const resolved = await decisions.resolve(actor, failureId, "resend");

    expect(resolved).toMatchObject({ clearReason: "operator_resolved" });
    expect(outbox.enqueue).toHaveBeenCalledOnce();
    const [[queued]] = outbox.enqueue.mock.calls;
    expect(queued.type).toBe(EMAIL_SEND_ACTION_TYPE);
    expect(queued.idempotencyKey).toBe(`email:send:msg:${SEND_IDS.message}:resend:1`);
    expect(queued.idempotencyKey).not.toBe(original.idempotencyKey);
    const payload = emailSendActionPayloadSchema.parse(queued.payload);
    expect(payload.trigger).toBe("audited_resend");
    expect(isEmailSendKeyFor(payload, queued.idempotencyKey!)).toBe(true);
    await expect(decisions.resolve(actor, failureId, "resend")).rejects.toMatchObject({ statusCode: 409 });
    expect(outbox.enqueue).toHaveBeenCalledOnce();
  });

  it("is what the operator reply route queues, keyed by the message", async () => {
    const clock = () => new Date("2026-10-04T09:00:00.000Z");
    const domains = new InMemoryEmailDomains(clock);
    const mailboxes = new InMemoryEmailMailboxes(clock);
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const domain = domains.seed({ workspaceId, domain: "customer.test", sendingStatus: "verified" });
    const mailbox = mailboxes.seed({ workspaceId, domainId: domain.id, address: "support@customer.test" });
    const outbox = { enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) };
    const deliverer = new EmailCustomerReplyDeliverer({ mailboxes, domains, ownership: { versionOf: async () => 0 } });

    const route = await deliverer.route({
      id: CONVERSATION,
      workspaceId,
      sourceChannel: "email",
      channelContext: { provider: "email", mailbox: { id: mailbox.id, address: mailbox.address }, threadKey: "thread-1", participant: { address: "pat@example.org" } },
    });
    await route?.enqueue(outbox, { id: MESSAGE, content: "Hello" });

    const [[queued]] = outbox.enqueue.mock.calls as unknown as [[{ type: string; idempotencyKey: string; payload: unknown }]];
    expect(queued.type).toBe(EMAIL_SEND_ACTION_TYPE);
    const payload = emailSendActionPayloadSchema.parse(queued.payload);
    expect(payload.trigger).toBe("operator_reply");
    expect(isEmailSendKeyFor(payload, queued.idempotencyKey)).toBe(true);
    expect(queued.idempotencyKey).toBe(`email:send:msg:${MESSAGE}`);
  });
});
