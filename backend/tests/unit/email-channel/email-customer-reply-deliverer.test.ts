import { describe, expect, it, vi } from "vitest";

import { EmailCustomerReplyDeliverer } from "../../../src/modules/emailChannel/public.js";
import { InMemoryEmailDomains, InMemoryEmailMailboxes } from "../../support/inMemoryEmailChannel.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "66666666-6666-4666-8666-666666666666";
const messageId = "77777777-7777-4777-8777-777777777777";
const clock = () => new Date("2026-10-04T09:00:00.000Z");

const setup = (options: { sendingStatus?: "pending" | "verified"; domainRemoved?: boolean; mailboxRemoved?: boolean } = {}) => {
  const domains = new InMemoryEmailDomains(clock);
  const mailboxes = new InMemoryEmailMailboxes(clock);
  const domain = domains.seed({
    workspaceId,
    domain: "customer.test",
    sendingStatus: options.sendingStatus ?? "verified",
    removedAt: options.domainRemoved ? clock() : null,
  });
  const mailbox = mailboxes.seed({
    workspaceId,
    domainId: domain.id,
    address: "support@customer.test",
    policyVersion: 3,
    removedAt: options.mailboxRemoved ? clock() : null,
  });
  const ownership = { versionOf: vi.fn(async () => 2) };
  const deliverer = new EmailCustomerReplyDeliverer({ mailboxes, domains, ownership });
  const conversation = {
    id: conversationId,
    workspaceId,
    sourceChannel: "email",
    channelContext: {
      provider: "email" as const,
      mailbox: { id: mailbox.id, address: mailbox.address },
      threadKey: "99999999-9999-4999-8999-999999999999",
      participant: { address: "pat@example.org" },
    },
  };
  const outbox = { enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) };
  return { deliverer, conversation, outbox, mailbox, domain };
};

describe("EmailCustomerReplyDeliverer", () => {
  it.each([
    ["the sending domain is not verified", { sendingStatus: "pending" as const }, "verify_sending_domain"],
    ["the sending domain was removed", { domainRemoved: true }, "add_sending_domain"],
    ["the mailbox was removed", { mailboxRemoved: true }, "add_mailbox"],
  ])("refuses with 409 email_sending_not_verified, naming the step, when %s", async (_label, options, step) => {
    const { deliverer, conversation } = setup(options);

    await expect(deliverer.route(conversation)).rejects.toMatchObject({
      statusCode: 409,
      code: "email_sending_not_verified",
      details: { step, domain: "customer.test" },
    });
  });

  it("refuses for a mailbox of another workspace", async () => {
    const { deliverer, conversation } = setup();

    await expect(deliverer.route({ ...conversation, workspaceId: "22222222-2222-4222-8222-222222222222" }))
      .rejects.toMatchObject({ statusCode: 409, code: "email_sending_not_verified", details: { step: "add_mailbox" } });
  });

  it("when ready, queues email.send keyed by the message, with ids and authority only", async () => {
    const { deliverer, conversation, outbox, mailbox, domain } = setup();

    const route = await deliverer.route(conversation);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    await route?.enqueue(outbox, { id: messageId, content: "Your order ships on Monday." });

    expect(outbox.enqueue).toHaveBeenCalledOnce();
    expect(outbox.enqueue).toHaveBeenCalledWith({
      type: "email.send",
      workspaceId,
      accountId: null,
      conversationId,
      idempotencyKey: `email:send:msg:${messageId}`,
      payload: {
        version: 1,
        trigger: "operator_reply",
        mailboxId: mailbox.id,
        conversationId,
        messageId,
        heldReplyId: null,
        authority: { policyVersion: 3, ownershipVersion: 2, mode: "operator_only", domainId: domain.id },
      },
    });
    expect(JSON.stringify(outbox.enqueue.mock.calls)).not.toMatch(/order ships|pat@example\.org|support@customer\.test/);
  });
});
