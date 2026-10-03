import { describe, expect, it } from "vitest";

import { ConversationEmailFactsReader } from "../../../src/modules/emailChannel/public.js";
import type {
  EmailThreadLinkRecord,
  ThreadIndexRecord,
} from "../../../src/modules/emailChannel/persistence/emailThreadRepository.js";
import { InMemoryEmailDomains, InMemoryEmailMailboxes } from "../../support/inMemoryEmailChannel.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "66666666-6666-4666-8666-666666666666";
const clock = () => new Date("2026-10-03T12:00:00.000Z");

const setup = (overrides: { link?: Partial<EmailThreadLinkRecord>; sendingStatus?: "pending" | "verified"; domainRemoved?: boolean } = {}) => {
  const domains = new InMemoryEmailDomains(clock);
  const mailboxes = new InMemoryEmailMailboxes(clock);
  const domain = domains.seed({
    workspaceId,
    domain: "customer.test",
    sendingStatus: overrides.sendingStatus ?? "verified",
    removedAt: overrides.domainRemoved ? clock() : null,
  });
  const mailbox = mailboxes.seed({ workspaceId, domainId: domain.id, address: "support@customer.test", threadSendBudget: 3 });
  const link: EmailThreadLinkRecord = {
    conversationId,
    workspaceId,
    mailboxId: mailbox.id,
    threadKey: "77777777-7777-4777-8777-777777777777",
    threadToken: "THREADTOKENTHREADTOKENTHRE",
    participantAddress: "person@example.org",
    latestSubject: "Re: Order 42",
    latestParticipantDisplayName: "Pat Person",
    latestCcAddresses: ["cc@example.org"],
    latestInboundAt: new Date("2026-10-03T11:00:00.000Z"),
    autoSendsSinceRenewal: 1,
    budgetRenewedAt: new Date("2026-10-02T09:00:00.000Z"),
    reviewRevision: 0,
    reviewCompletedRevision: 0,
    reviewDueAt: null,
    reviewPolicyVersion: null,
    ...overrides.link,
  };
  const entry = (patch: Partial<ThreadIndexRecord> & Pick<ThreadIndexRecord, "id" | "rfcMessageId">): ThreadIndexRecord => ({
    workspaceId,
    mailboxId: mailbox.id,
    conversationId,
    messageId: null,
    direction: "referenced",
    origin: "referenced",
    subject: null,
    ccAddresses: [],
    attachments: [],
    inboundDeliveryId: null,
    createdAt: clock(),
    ...patch,
  });
  const index: ThreadIndexRecord[] = [
    entry({ id: "i1", rfcMessageId: "<root@example.org>" }),
    entry({
      id: "i2",
      rfcMessageId: "<first@example.org>",
      messageId: "m1",
      direction: "inbound",
      origin: "inbound",
      subject: "Order 42",
      ccAddresses: ["cc@example.org"],
      attachments: [{ name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 2048 }],
      inboundDeliveryId: "d1",
    }),
    entry({ id: "i3", rfcMessageId: "<sent@customer.test>", messageId: "m2", direction: "outbound", origin: "radioso_generated", subject: "Re: Order 42" }),
    entry({ id: "i4", rfcMessageId: "<ses-id@email.amazonses.com>", messageId: "m2", direction: "outbound", origin: "provider_delivered", subject: "Re: Order 42" }),
    entry({ id: "i5", rfcMessageId: "<second@example.org>", messageId: "m3", direction: "inbound", origin: "inbound", subject: "Re: Order 42", inboundDeliveryId: "d2" }),
  ];
  const threads = {
    findLink: async (id: string) => (id === conversationId ? link : null),
    listIndexedMessages: async (id: string) => (id === conversationId ? index : []),
  };
  const reader = new ConversationEmailFactsReader({ threads, mailboxes, domains });
  return { reader, mailbox, mailboxes };
};

describe("ConversationEmailFactsReader", () => {
  it("returns the latest header projection and per-message subject, CC, attachments and raw delivery id", async () => {
    const { reader, mailbox } = setup();
    expect(await reader.read(workspaceId, conversationId)).toEqual({
      mailbox: { id: mailbox.id, address: "support@customer.test", displayName: "Support", engagementMode: "operator_only" },
      participant: { address: "person@example.org", displayName: "Pat Person" },
      latest: { subject: "Re: Order 42", cc: ["cc@example.org"], inboundAt: "2026-10-03T11:00:00.000Z" },
      sending: { state: "ok" },
      sendBudget: { used: 1, limit: 3, renewedAt: "2026-10-02T09:00:00.000Z" },
      messages: [
        {
          messageId: "m1",
          direction: "inbound",
          subject: "Order 42",
          cc: ["cc@example.org"],
          attachments: [{ name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 2048 }],
          delivery: null,
          rawDeliveryId: "d1",
        },
        { messageId: "m2", direction: "outbound", subject: "Re: Order 42", cc: [], attachments: [], delivery: null, rawDeliveryId: null },
        { messageId: "m3", direction: "inbound", subject: "Re: Order 42", cc: [], attachments: [], delivery: null, rawDeliveryId: "d2" },
      ],
    });
  });

  it("reports delivery as null on every message in S1, before the send path exists", async () => {
    const { reader } = setup();
    const facts = await reader.read(workspaceId, conversationId);
    expect(facts?.messages.map((message) => message.delivery)).toEqual([null, null, null]);
  });

  it("derives the sending state from the mailbox's domain", async () => {
    expect((await setup({ sendingStatus: "pending" }).reader.read(workspaceId, conversationId))?.sending).toEqual({ state: "not_verified" });
    expect((await setup({ domainRemoved: true }).reader.read(workspaceId, conversationId))?.sending).toEqual({ state: "domain_removed" });
  });

  it("still describes a conversation whose mailbox was removed", async () => {
    const { reader, mailboxes, mailbox } = setup();
    await mailboxes.markRemoved(workspaceId, mailbox.id);
    expect((await reader.read(workspaceId, conversationId))?.mailbox.id).toBe(mailbox.id);
  });

  it("returns null for a conversation that is not an email conversation of the workspace", async () => {
    const { reader } = setup();
    expect(await reader.read(workspaceId, "88888888-8888-4888-8888-888888888888")).toBeNull();
    expect(await reader.read("22222222-2222-4222-8222-222222222222", conversationId)).toBeNull();
  });

  it("never exposes the thread token", async () => {
    const { reader } = setup();
    expect(JSON.stringify(await reader.read(workspaceId, conversationId))).not.toContain("THREADTOKEN");
  });
});
