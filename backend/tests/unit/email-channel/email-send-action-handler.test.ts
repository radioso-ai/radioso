import { describe, expect, it } from "vitest";

import { emailSendKey } from "../../../src/modules/emailChannel/public.js";
import { EmailSendError } from "../../../src/modules/mail/public.js";
import { createSendPathHarness, SEND_IDS } from "../../support/inMemoryEmailSend.js";

const HOUR = 60 * 60 * 1000;

describe("EmailSendActionHandler", () => {
  describe("materialization", () => {
    it("materializes the intent under the outbox key on the first claim, and a redelivery reuses it", async () => {
      const h = createSendPathHarness();

      await h.deliver();
      await h.deliver({ context: { attempt: 2 } });

      const intent = h.onlyIntent();
      expect(intent).toMatchObject({
        idempotencyKey: emailSendKey.message(SEND_IDS.message),
        trigger: "operator_reply",
        messageId: SEND_IDS.message,
        conversationId: SEND_IDS.conversation,
        mailboxId: h.mailbox.id,
        provider: "resend",
        suppliedRfcMessageId: `<${intent.id}@customer.test>`,
        authority: { policyVersion: 1, ownershipVersion: 0, mode: "operator_only", domainId: h.domain.id },
      });
      expect(h.driver.send).toHaveBeenCalledOnce();
      expect(h.counted("email_send_intents_total")).toContainEqual({ trigger: "operator_reply", state: "queued" });
    });

    it("materializes a released held reply's send under its message key", async () => {
      const h = createSendPathHarness();

      await h.deliver({ payload: { trigger: "held_release", heldReplyId: SEND_IDS.heldReply } });

      expect(h.onlyIntent()).toMatchObject({ trigger: "held_release", heldReplyId: SEND_IDS.heldReply, state: "accepted" });
    });

    it("renews the thread's automatic-send budget when an operator-authorized send materializes, once", async () => {
      const h = createSendPathHarness();

      await h.deliver();
      const renewed = h.threads.links.get(SEND_IDS.conversation)!;
      expect(renewed).toMatchObject({ autoSendsSinceRenewal: 0, budgetRenewedAt: h.clock() });

      h.threads.links.set(SEND_IDS.conversation, { ...renewed, autoSendsSinceRenewal: 1 });
      await h.deliver({ context: { attempt: 2 } });
      expect(h.threads.links.get(SEND_IDS.conversation)?.autoSendsSinceRenewal).toBe(1);
    });

    it.each([
      ["human_agent", "operator", null],
      ["human_agent_on_behalf_of_ai_agent", "operator", null],
      ["ai_agent", "agent", "auto-generated"],
      [null, "agent", "auto-generated"],
    ] as const)("takes the author from messages.source %s", async (source, authorKind, autoSubmitted) => {
      const h = createSendPathHarness();
      h.messages.set(SEND_IDS.message, { ...h.messages.get(SEND_IDS.message)!, source });

      await h.deliver();

      expect(h.onlyIntent().authorKind).toBe(authorKind);
      expect(h.sentMessages[0]?.threading?.autoSubmitted).toBe(autoSubmitted);
    });

    it("refuses an action whose key is not the one its trigger requires, or whose payload carries content", async () => {
      const h = createSendPathHarness();

      await expect(h.deliver({ context: { idempotencyKey: "email:send:msg:other" } })).rejects.toThrow("email_send_key_mismatch");
      await expect(h.handler.handle({ payload: { ...h.payload(), text: "hello" }, context: h.context() }))
        .rejects.toThrow("email_send_malformed_payload");
      expect(h.intents.rows.size).toBe(0);
    });

    it("leaves automatic replies to the held-reply dispatch port", async () => {
      const h = createSendPathHarness();

      await expect(h.deliver({
        payload: { trigger: "auto_reply", messageId: null, heldReplyId: SEND_IDS.heldReply },
        context: { idempotencyKey: emailSendKey.heldReply(SEND_IDS.heldReply) },
      })).rejects.toThrow("email_send_auto_reply_unavailable");
      expect(h.driver.send).not.toHaveBeenCalled();
    });
  });

  describe("revalidation", () => {
    it.each([
      ["an unverified domain", (h: ReturnType<typeof createSendPathHarness>) => h.domains.seed({ ...h.domain, sendingStatus: "pending" }), "sending_not_verified"],
      ["a removed domain", (h: ReturnType<typeof createSendPathHarness>) => h.domains.seed({ ...h.domain, removedAt: h.clock() }), "domain_removed"],
      ["a removed mailbox", (h: ReturnType<typeof createSendPathHarness>) => h.mailboxes.seed({ ...h.mailbox, removedAt: h.clock() }), "mailbox_removed"],
    ] as const)("halts before the first provider call on %s, and flags the message", async (_label, revoke, haltReason) => {
      const h = createSendPathHarness();
      revoke(h);

      await h.deliver();

      expect(h.onlyIntent()).toMatchObject({ state: "halted", haltReason, request: null });
      expect(h.driver.send).not.toHaveBeenCalled();
      expect(h.failures.openFor(SEND_IDS.message)).toMatchObject({ kind: "halted", detailCode: haltReason, provider: "email" });
      expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ haltReason }), "email_send_halted");
    });

    it("revalidates on the first attempt only: a frozen request later finds authority revoked and becomes uncertain, not halted", async () => {
      const h = createSendPathHarness();
      h.driver.send.mockRejectedValueOnce(new EmailSendError("retryable", "rate_limited"));
      await expect(h.deliver()).rejects.toThrow("email_send_retryable:rate_limited");

      h.domains.seed({ ...h.domain, sendingStatus: "pending" });
      await h.deliver({ context: { attempt: 2 } });

      expect(h.onlyIntent()).toMatchObject({ state: "uncertain", haltReason: null });
      expect(h.driver.send).toHaveBeenCalledOnce();
      expect(h.failures.openFor(SEND_IDS.message)?.kind).toBe("uncertain");
    });
  });

  describe("the request", () => {
    it("freezes the snapshot on the first attempt: the mailbox's address, the thread's headers and the message text", async () => {
      const h = createSendPathHarness();
      h.mailboxes.seed({ ...h.mailbox, plusAddressVerifiedAt: h.clock() });

      await h.deliver();

      const intent = h.onlyIntent();
      expect(h.sentMessages[0]).toEqual({
        to: "pat@example.org",
        from: { email: "support@customer.test", name: "Support" },
        replyTo: "support+THREADTOKENABCDEFGH234567@customer.test",
        subject: "Re: Order 42",
        text: "Your order ships on Monday.",
        kind: "channel_reply",
        idempotencyKey: emailSendKey.message(SEND_IDS.message),
        threading: {
          messageId: intent.suppliedRfcMessageId,
          inReplyTo: "<second@example.org>",
          references: ["<root@example.org>", "<first@example.org>", "<second@example.org>"],
          autoSubmitted: null,
        },
      });
      expect(intent.request?.threading.messageId).toBe(intent.suppliedRfcMessageId);
      expect(intent.firstAttemptAt).toEqual(h.clock());
    });

    it("re-POSTs the frozen request, unchanged and under the same key, after a retryable refusal", async () => {
      const h = createSendPathHarness();
      h.driver.send.mockRejectedValueOnce(new EmailSendError("retryable", "rate_limited"));
      await expect(h.deliver()).rejects.toThrow();

      h.messages.set(SEND_IDS.message, { ...h.messages.get(SEND_IDS.message)!, content: "Edited after the first attempt." });
      h.mailboxes.seed({ ...h.mailbox, displayName: "Renamed" });
      await h.deliver({ context: { attempt: 2 } });

      const [[first], [second]] = h.driver.send.mock.calls;
      expect(second).toEqual(first);
      expect(second?.text).toBe("Your order ships on Monday.");
      expect(h.onlyIntent().state).toBe("accepted");
    });
  });

  describe("outcomes", () => {
    it("records the provider id and the delivered id on acceptance, indexing both Message-Ids when they differ", async () => {
      const h = createSendPathHarness();
      h.driver.lookup.mockResolvedValueOnce({
        providerMessageId: "re_provider_1",
        deliveredMessageId: "<ses-1@email.amazonses.com>" as never,
        lastEvent: "sent",
      });

      await h.deliver();

      const intent = h.onlyIntent();
      expect(intent).toMatchObject({
        state: "accepted",
        providerMessageId: "re_provider_1",
        deliveredRfcMessageId: "<ses-1@email.amazonses.com>",
        acceptedAt: h.clock(),
        nextReconcileAt: new Date(h.clock().getTime() + 24 * HOUR),
      });
      const outbound = h.threads.index.filter((entry) => entry.direction === "outbound");
      expect(outbound).toEqual([
        expect.objectContaining({ rfcMessageId: intent.suppliedRfcMessageId, origin: "radioso_generated", messageId: SEND_IDS.message, sendIntentId: intent.id }),
        expect.objectContaining({ rfcMessageId: "<ses-1@email.amazonses.com>", origin: "provider_delivered", messageId: SEND_IDS.message, sendIntentId: intent.id }),
      ]);
      expect(h.counted("email_send_provider_calls_total")).toEqual([{ result: "accepted" }]);
      expect(h.counted("email_send_intents_total")).toContainEqual({ trigger: "operator_reply", state: "accepted" });
    });

    it("indexes one Message-Id when the provider delivers under the supplied one", async () => {
      const h = createSendPathHarness();
      h.driver.send.mockImplementationOnce(async (message) => ({
        dispatched: true,
        providerMessageId: "local-1",
        deliveredMessageId: message.threading!.messageId,
      }));

      await h.deliver();

      expect(h.threads.index.filter((entry) => entry.direction === "outbound")).toHaveLength(1);
      expect(h.driver.lookup).not.toHaveBeenCalled();
    });

    it("on an unknown outcome keeps the send queued and schedules a reconcile drain at the next re-POST time", async () => {
      const h = createSendPathHarness();
      h.driver.send.mockRejectedValueOnce(new EmailSendError("unknown", "timeout"));

      await h.deliver();

      const intent = h.onlyIntent();
      expect(intent).toMatchObject({ state: "queued", outcomeUnknown: true, outcomeUnknownSince: h.clock() });
      expect(intent.nextReconcileAt).toEqual(new Date(h.clock().getTime() + 5 * 60 * 1000));
      expect(h.drains.requestDrain).toHaveBeenCalledWith({ maxJobs: 5, stage: "reconcile", scheduleAt: intent.nextReconcileAt });
      expect(h.failures.rows).toEqual([]);
      expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ sendIntentId: intent.id, code: "timeout" }), "email_send_outcome_unknown");

      // A redelivery leaves the re-POST to the reconciler.
      await h.deliver({ context: { attempt: 2 } });
      expect(h.driver.send).toHaveBeenCalledOnce();
    });

    it("fails a definite rejection and flags the message with the sanitized code", async () => {
      const h = createSendPathHarness();
      h.driver.send.mockRejectedValueOnce(new EmailSendError("rejected", "rejected"));

      await h.deliver();

      expect(h.onlyIntent()).toMatchObject({ state: "failed", failureCode: "rejected" });
      expect(h.failures.openFor(SEND_IDS.message)).toMatchObject({ kind: "failed", detailCode: "rejected" });
      expect(h.counted("email_send_provider_calls_total")).toEqual([{ result: "rejected" }]);
    });

    it("holds no transaction open across the provider call", async () => {
      const h = createSendPathHarness();

      await h.deliver();

      expect(h.openUnitsAtSend).toEqual([0]);
      expect(h.unitOfWork.runs).toBeGreaterThanOrEqual(2);
    });
  });

  describe("recordFailureOutcome", () => {
    const exhaust = (h: ReturnType<typeof createSendPathHarness>) =>
      h.handler.recordFailureOutcome({ payload: { ...h.payload() }, context: h.context({ attempt: 5 }), outcome: "failed", error: "email_send_thread_not_found" });

    it("fails a send that never reached the provider, with a delivery failure", async () => {
      const h = createSendPathHarness();
      h.threads.links.delete(SEND_IDS.conversation);
      await expect(h.deliver()).rejects.toThrow("email_send_thread_not_found");

      await exhaust(h);

      expect(h.onlyIntent()).toMatchObject({ state: "failed", failureCode: "dispatch_exhausted" });
      expect(h.failures.openFor(SEND_IDS.message)).toMatchObject({ kind: "failed", detailCode: "dispatch_exhausted" });
    });

    it("makes a send whose frozen request may have reached the provider uncertain, never resent", async () => {
      const h = createSendPathHarness();
      h.driver.send.mockRejectedValue(new EmailSendError("retryable", "rate_limited"));
      await expect(h.deliver()).rejects.toThrow();

      await exhaust(h);

      expect(h.onlyIntent()).toMatchObject({ state: "uncertain", nextReconcileAt: null });
      expect(h.failures.openFor(SEND_IDS.message)?.kind).toBe("uncertain");
    });

    it("flags the message when its send never materialized", async () => {
      const h = createSendPathHarness();
      h.messages.delete(SEND_IDS.message);
      await expect(h.deliver()).rejects.toThrow("email_send_message_not_found");

      await exhaust(h);

      expect(h.intents.rows.size).toBe(0);
      expect(h.failures.openFor(SEND_IDS.message)).toMatchObject({
        kind: "failed",
        conversationId: SEND_IDS.conversation,
        workspaceId: SEND_IDS.workspace,
      });
    });

    it("does nothing while the outbox will still retry, or once the send has an outcome", async () => {
      const h = createSendPathHarness();
      await h.deliver();
      await h.handler.recordFailureOutcome({ payload: { ...h.payload() }, context: h.context(), outcome: "retry", error: "x" });
      await exhaust(h);

      expect(h.onlyIntent().state).toBe("accepted");
      expect(h.failures.rows).toEqual([]);
    });
  });
});
