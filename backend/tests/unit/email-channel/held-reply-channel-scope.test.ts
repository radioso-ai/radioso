import { describe, expect, it } from "vitest";

import type { CustomerReplyOutboxPort } from "../../../src/modules/customerReplyDelivery/public.js";
import { emailSendActionPayloadSchema, isEmailSendKeyFor } from "../../../src/modules/emailChannel/outbound/emailSendAction.js";
import {
  EMAIL_SEND_ACTION_TYPE,
  EmailHeldReplyChannelScope,
  emailMailboxPolicyRef,
  emailSendKey,
} from "../../../src/modules/emailChannel/public.js";
import type { HeldReplyAuthorityView } from "../../../src/modules/handoff/public.js";
import { InMemoryEmailDomains, InMemoryEmailMailboxes, InMemoryEmailThreads } from "../../support/inMemoryEmailChannel.js";
import { InMemoryEmailSendIntents } from "../../support/inMemoryEmailSend.js";

const NOW = new Date("2026-10-05T09:00:00.000Z");
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";
const HELD_REPLY_ID = "88888888-8888-4888-8888-888888888888";
const MESSAGE_ID = "77777777-7777-4777-8777-777777777777";
const INTENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

type Enqueued = Parameters<CustomerReplyOutboxPort["enqueue"]>[0];

/** An `auto` mailbox on a verified domain with one thread, and email's scope over in-memory tables. */
const harness = async (options: { autoSend?: boolean } = {}) => {
  const clock = () => NOW;
  const domains = new InMemoryEmailDomains(clock);
  const mailboxes = new InMemoryEmailMailboxes(clock);
  const threads = new InMemoryEmailThreads([], clock);
  const intents = new InMemoryEmailSendIntents(clock, threads);
  const owners = new Map<string, { state: "ai_owned" | "human_owned"; version: number }>();
  const domain = domains.seed({ workspaceId: WORKSPACE_ID, domain: "customer.test", sendingStatus: "verified" });
  const mailbox = mailboxes.seed({ workspaceId: WORKSPACE_ID, domainId: domain.id, address: "support@customer.test", engagementMode: "auto", policyVersion: 4 });
  await threads.upsertLink({
    conversationId: CONVERSATION_ID,
    workspaceId: WORKSPACE_ID,
    mailboxId: mailbox.id,
    threadKey: "99999999-9999-4999-8999-999999999999",
    threadToken: "THREADTOKENABCDEFGH234567",
    participantAddress: "pat@example.org",
  });
  const outbox: Enqueued[] = [];
  const outboxPort: CustomerReplyOutboxPort = {
    enqueue: async (request) => {
      outbox.push(request);
      return { id: `outbox-${outbox.length}`, duplicate: false };
    },
  };
  const scope = new EmailHeldReplyChannelScope({
    mailboxes,
    domains,
    autoSend: options.autoSend === false ? undefined : {
      threads,
      ownership: { load: async (conversationId) => owners.get(conversationId) ?? null },
      intents,
      provider: "resend",
      createId: () => INTENT_ID,
    },
  });
  const heldReply = (overrides: Partial<HeldReplyAuthorityView> = {}): HeldReplyAuthorityView => ({
    id: HELD_REPLY_ID,
    conversationId: CONVERSATION_ID,
    policyRef: emailMailboxPolicyRef(mailbox.id),
    policyVersion: 4,
    ownershipVersion: 0,
    ...overrides,
  });
  return { scope, domains, domain, mailboxes, mailbox, threads, intents, owners, outbox, outboxPort, heldReply };
};

describe("EmailHeldReplyChannelScope, automatic sends (research B8, B9)", () => {
  describe("reserveAutoSend: the thread's send budget (FR-022)", () => {
    it("spends one send per reservation until the mailbox's thread budget is spent, then refuses", async () => {
      const h = await harness();

      const reserved = [];
      for (let attempt = 0; attempt < 4; attempt += 1) reserved.push(await h.scope.reserveAutoSend(CONVERSATION_ID));

      expect(reserved).toEqual([true, true, true, false]);
      expect(h.threads.links.get(CONVERSATION_ID)?.autoSendsSinceRenewal).toBe(3);
      expect(h.mailboxes.calls).toContain("lockPolicy");
    });

    it("reads the limit from the thread's mailbox", async () => {
      const h = await harness();
      h.mailboxes.records.set(h.mailbox.id, { ...h.mailbox, threadSendBudget: 1 });

      expect(await h.scope.reserveAutoSend(CONVERSATION_ID)).toBe(true);
      expect(await h.scope.reserveAutoSend(CONVERSATION_ID)).toBe(false);
    });

    it("reserves again once an operator-authorized send renews the budget, and never because the customer wrote again", async () => {
      const h = await harness();
      for (let attempt = 0; attempt < 3; attempt += 1) await h.scope.reserveAutoSend(CONVERSATION_ID);

      await h.threads.recordLatestInbound(CONVERSATION_ID, {
        inboundAt: NOW,
        subject: "Re: Order 42",
        participantDisplayName: "Pat",
        ccAddresses: [],
      });
      await h.threads.scheduleReview(CONVERSATION_ID, { dueAt: NOW, policyVersion: 4 });
      expect(await h.scope.reserveAutoSend(CONVERSATION_ID)).toBe(false);

      await h.threads.renewSendBudget(CONVERSATION_ID);
      expect(await h.scope.reserveAutoSend(CONVERSATION_ID)).toBe(true);
    });

    it("reserves nothing on a conversation with no thread, or whose mailbox was removed", async () => {
      const h = await harness();
      expect(await h.scope.reserveAutoSend("12121212-1212-4212-8212-121212121212")).toBe(false);

      h.mailboxes.records.set(h.mailbox.id, { ...h.mailbox, removedAt: NOW });
      expect(await h.scope.reserveAutoSend(CONVERSATION_ID)).toBe(false);
      expect(h.threads.links.get(CONVERSATION_ID)?.autoSendsSinceRenewal).toBe(0);
    });
  });

  describe("enqueueAutoSend", () => {
    it("queues one auto_reply email.send keyed by the held reply, with no message yet and the bound authority", async () => {
      const h = await harness();

      await h.scope.enqueueAutoSend(h.heldReply({ ownershipVersion: 2 }), h.outboxPort);

      expect(h.outbox).toEqual([{
        type: EMAIL_SEND_ACTION_TYPE,
        workspaceId: WORKSPACE_ID,
        accountId: null,
        conversationId: CONVERSATION_ID,
        idempotencyKey: `email:send:held:${HELD_REPLY_ID}`,
        payload: {
          version: 1,
          trigger: "auto_reply",
          mailboxId: h.mailbox.id,
          conversationId: CONVERSATION_ID,
          messageId: null,
          heldReplyId: HELD_REPLY_ID,
          authority: { policyVersion: 4, ownershipVersion: 2, mode: "auto", domainId: h.domain.id },
        },
      }]);
      const payload = emailSendActionPayloadSchema.parse(h.outbox[0]?.payload);
      expect(isEmailSendKeyFor(payload, emailSendKey.heldReply(HELD_REPLY_ID))).toBe(true);
    });

    it("refuses to queue for a policy ref that names no active mailbox", async () => {
      const h = await harness();
      h.mailboxes.records.set(h.mailbox.id, { ...h.mailbox, removedAt: NOW });

      await expect(h.scope.enqueueAutoSend(h.heldReply(), h.outboxPort)).rejects.toThrow();
      expect(h.outbox).toEqual([]);
    });
  });

  describe("authorizeAutoDispatch (FR-032)", () => {
    it("authorizes an enabled auto mailbox at the bound policy, the AI's conversation at the bound ownership, and a verified domain", async () => {
      const h = await harness();
      h.owners.set(CONVERSATION_ID, { state: "ai_owned", version: 2 });

      expect(await h.scope.authorizeAutoDispatch(h.heldReply({ ownershipVersion: 2 }))).toEqual({ authorized: true });
      // A conversation with no ownership row is the AI's, at version 0.
      const unowned = "12121212-1212-4212-8212-121212121212";
      await h.threads.upsertLink({
        conversationId: unowned,
        workspaceId: WORKSPACE_ID,
        mailboxId: h.mailbox.id,
        threadKey: "13131313-1313-4313-8313-131313131313",
        threadToken: "THREADTOKENZYXWVUTSRQPON2",
        participantAddress: "sam@example.org",
      });
      expect(await h.scope.authorizeAutoDispatch(h.heldReply({ conversationId: unowned }))).toEqual({ authorized: true });
    });

    it("authorizes a send whose reservation still fits the thread's budget, and refuses one the operator lowered the budget below (FR-022)", async () => {
      const h = await harness();
      expect(await h.scope.reserveAutoSend(CONVERSATION_ID)).toBe(true);
      expect(await h.scope.reserveAutoSend(CONVERSATION_ID)).toBe(true);
      expect(await h.scope.authorizeAutoDispatch(h.heldReply())).toEqual({ authorized: true });

      h.mailboxes.records.set(h.mailbox.id, { ...h.mailbox, threadSendBudget: 1 });

      expect(await h.scope.authorizeAutoDispatch(h.heldReply())).toEqual({ authorized: false, code: "send_budget" });
    });

    it("refuses a send on a conversation with no thread to count its budget against", async () => {
      const h = await harness();

      expect(await h.scope.authorizeAutoDispatch(h.heldReply({ conversationId: "14141414-1414-4414-8414-141414141414" })))
        .toEqual({ authorized: false, code: "send_budget" });
    });

    it.each([
      ["the mailbox is disabled", (h: Harness) => h.mailboxes.records.set(h.mailbox.id, { ...h.mailbox, enabled: false }), "mailbox_disabled"],
      ["the mailbox no longer runs auto", (h: Harness) => h.mailboxes.records.set(h.mailbox.id, { ...h.mailbox, engagementMode: "draft" }), "mode_not_auto"],
      ["the policy moved", (h: Harness) => h.mailboxes.records.set(h.mailbox.id, { ...h.mailbox, policyVersion: 5 }), "policy_changed"],
      ["the mailbox was removed", (h: Harness) => h.mailboxes.records.set(h.mailbox.id, { ...h.mailbox, removedAt: NOW }), "mailbox_removed"],
      ["a person took the conversation", (h: Harness) => h.owners.set(CONVERSATION_ID, { state: "human_owned", version: 1 }), "human_owned"],
      ["the ownership moved and came back", (h: Harness) => h.owners.set(CONVERSATION_ID, { state: "ai_owned", version: 2 }), "ownership_changed"],
      ["the domain is no longer verified", (h: Harness) => h.domains.seed({ ...h.domain, sendingStatus: "pending" }), "sending_not_verified"],
      ["the domain was removed", (h: Harness) => h.domains.seed({ ...h.domain, removedAt: NOW }), "domain_removed"],
    ] as const)("refuses when %s", async (_label, change, code) => {
      const h = await harness();
      change(h);

      expect(await h.scope.authorizeAutoDispatch(h.heldReply())).toEqual({ authorized: false, code });
    });

    it("refuses every automatic send where the deployment does not run auto (the rollback path)", async () => {
      const h = await harness({ autoSend: false });

      expect(await h.scope.authorizeAutoDispatch(h.heldReply())).toEqual({ authorized: false, code: "auto_unsupported" });
      expect(await h.scope.reserveAutoSend(CONVERSATION_ID)).toBe(false);
      await expect(h.scope.enqueueAutoSend(h.heldReply(), h.outboxPort)).rejects.toThrow();
      await expect(h.scope.recordMaterialized(h.heldReply(), MESSAGE_ID)).rejects.toThrow();
      expect(h.outbox).toEqual([]);
      expect(h.intents.rows.size).toBe(0);
    });

    it("refuses a held reply bound to no email policy", async () => {
      const h = await harness();

      expect(await h.scope.authorizeAutoDispatch(h.heldReply({ policyRef: null, policyVersion: null })))
        .toEqual({ authorized: false, code: "mailbox_removed" });
    });
  });

  describe("recordMaterialized", () => {
    it("writes the send intent under the held reply's key with the message, as the agent's auto_reply", async () => {
      const h = await harness();

      await h.scope.recordMaterialized(h.heldReply({ ownershipVersion: 2 }), MESSAGE_ID);

      expect([...h.intents.rows.values()]).toEqual([expect.objectContaining({
        id: INTENT_ID,
        workspaceId: WORKSPACE_ID,
        mailboxId: h.mailbox.id,
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        heldReplyId: HELD_REPLY_ID,
        idempotencyKey: emailSendKey.heldReply(HELD_REPLY_ID),
        authorKind: "agent",
        trigger: "auto_reply",
        state: "queued",
        authority: { policyVersion: 4, ownershipVersion: 2, mode: "auto", domainId: h.domain.id },
        provider: "resend",
        suppliedRfcMessageId: `<${INTENT_ID}@customer.test>`,
      })]);
    });

    it("never spends or renews the thread's send budget", async () => {
      const h = await harness();
      await h.scope.reserveAutoSend(CONVERSATION_ID);

      await h.scope.recordMaterialized(h.heldReply(), MESSAGE_ID);

      expect(h.threads.links.get(CONVERSATION_ID)?.autoSendsSinceRenewal).toBe(1);
    });
  });
});

type Harness = Awaited<ReturnType<typeof harness>>;
