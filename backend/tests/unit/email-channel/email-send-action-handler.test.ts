import { describe, expect, it, vi } from "vitest";

import { emailSendKey } from "../../../src/modules/emailChannel/public.js";
import { EmailSendError } from "../../../src/modules/mail/public.js";
import { createSendPathHarness, SEND_IDS } from "../../support/inMemoryEmailSend.js";

const HOUR = 60 * 60 * 1000;
const FROZEN_ELSEWHERE = "email_send_frozen_by_another_claim";

/** The next provider call, held open until released: the claim making it is in flight. */
const heldProviderCall = (h: ReturnType<typeof createSendPathHarness>) => {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.driver.send.mockImplementationOnce(async () => {
    enter();
    await released;
    return { dispatched: true, providerMessageId: "re_provider_frozen_by_b", deliveredMessageId: null };
  });
  return { entered, release };
};

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

    it("logs the send the provider accepted at info, with ids only", async () => {
      const h = createSendPathHarness();

      await h.deliver();

      const intent = h.onlyIntent();
      expect(h.logger.info).toHaveBeenCalledExactlyOnceWith({
        sendIntentId: intent.id,
        workspaceId: intent.workspaceId,
        mailboxId: h.mailbox.id,
        conversationId: SEND_IDS.conversation,
        trigger: "operator_reply",
        attempt: 1,
      }, "email_send_accepted");
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
  });

  describe("auto_reply (research B9)", () => {
    /** The send path with its mailbox in `auto`, as the publish that queued the action found it. */
    const autoHarness = () => {
      const h = createSendPathHarness();
      h.mailboxes.seed({ ...h.mailbox, engagementMode: "auto" });
      return h;
    };

    it("materializes the held reply through the dispatch port first, then sends the agent's message under the held key", async () => {
      const h = autoHarness();

      await h.deliverAuto();

      expect(h.materializeAuto).toHaveBeenCalledExactlyOnceWith(SEND_IDS.heldReply);
      expect(h.materializeAuto.mock.invocationCallOrder[0]).toBeLessThan(h.driver.send.mock.invocationCallOrder[0]);
      expect(h.onlyIntent()).toMatchObject({
        trigger: "auto_reply",
        idempotencyKey: emailSendKey.heldReply(SEND_IDS.heldReply),
        messageId: SEND_IDS.autoMessage,
        heldReplyId: SEND_IDS.heldReply,
        authorKind: "agent",
        state: "accepted",
      });
      expect(h.sentMessages).toEqual([expect.objectContaining({
        idempotencyKey: emailSendKey.heldReply(SEND_IDS.heldReply),
        text: "Your order ships on Monday.",
        threading: expect.objectContaining({ autoSubmitted: "auto-generated" }),
      })]);
      expect(h.counted("email_send_intents_total")).toContainEqual({ trigger: "auto_reply", state: "queued" });
    });

    it("spends no budget and renews none: the publish reserved its send", async () => {
      const h = autoHarness();

      await h.deliverAuto();

      expect(h.threads.links.get(SEND_IDS.conversation)?.autoSendsSinceRenewal).toBe(2);
    });

    it("reuses the materialized intent on a redelivery and never materializes twice", async () => {
      const h = autoHarness();
      h.driver.send.mockRejectedValueOnce(new EmailSendError("retryable", "rate_limited"));
      await expect(h.deliverAuto()).rejects.toThrow("email_send_retryable:rate_limited");

      await h.deliverAuto(2);

      expect(h.materializeAuto).toHaveBeenCalledOnce();
      expect(h.onlyIntent()).toMatchObject({ trigger: "auto_reply", state: "accepted" });
      const [[first], [second]] = h.driver.send.mock.calls;
      expect(second).toEqual(first);
    });

    it.each([
      ["superseded while queued: not_queued", "superseded", "not_queued"],
      ["returned to pending by revoked authority", "queued_auto", "returned_to_pending"],
    ] as const)("sends nothing when the held reply was %s", async (_label, state, reason) => {
      const h = autoHarness();
      h.autoReply.state = state;
      if (reason === "returned_to_pending") h.owners.set(SEND_IDS.conversation, { state: "human_owned", version: 1 });

      await h.deliverAuto();

      expect(await h.materializeAuto.mock.results[0]?.value).toEqual({ ok: false, reason });
      expect(h.driver.send).not.toHaveBeenCalled();
      expect(h.intents.rows.size).toBe(0);
      expect(h.messages.has(SEND_IDS.autoMessage)).toBe(false);
      expect(h.failures.rows).toEqual([]);
    });

    it("returns the held reply to pending, with no message, when a downgrade landed between publish and dispatch", async () => {
      const h = autoHarness();
      h.mailboxes.seed({ ...h.mailbox, engagementMode: "draft", policyVersion: h.mailbox.policyVersion + 1 });

      await h.deliverAuto();

      expect(h.autoReply.state).toBe("pending");
      expect(h.driver.send).not.toHaveBeenCalled();
      expect(h.intents.rows.size).toBe(0);
    });

    it("sends nothing for a queued reply a downgrade to draft held for review first, leaving it pending for a teammate (AS5.8)", async () => {
      const h = autoHarness();
      // The policy change returned it to pending, re-bound to the version it wrote, before dispatch.
      h.mailboxes.seed({ ...h.mailbox, engagementMode: "draft", policyVersion: h.mailbox.policyVersion + 1 });
      h.autoReply.state = "pending";

      await h.deliverAuto();

      expect(await h.materializeAuto.mock.results[0]?.value).toEqual({ ok: false, reason: "not_queued" });
      expect(h.autoReply.state).toBe("pending");
      expect(h.driver.send).not.toHaveBeenCalled();
      expect(h.intents.rows.size).toBe(0);
      expect(h.messages.has(SEND_IDS.autoMessage)).toBe(false);
      expect(h.failures.rows).toEqual([]);
      expect(h.counted("email_auto_dispatch_total")).toEqual([{ result: "not_queued" }]);
    });

    it("returns the held reply to pending, with no message, when the thread's budget was lowered below its reservation before dispatch", async () => {
      const h = autoHarness();
      // The publish reserved the thread's second send under a budget of three; the operator lowered it to one.
      h.mailboxes.seed({ ...h.mailbox, engagementMode: "auto", threadSendBudget: 1 });

      await h.deliverAuto();

      expect(await h.materializeAuto.mock.results[0]?.value).toEqual({ ok: false, reason: "returned_to_pending" });
      expect(h.autoReply.state).toBe("pending");
      expect(h.driver.send).not.toHaveBeenCalled();
      expect(h.intents.rows.size).toBe(0);
    });

    describe("a send recovered after its materialization committed and the worker stopped before freezing it", () => {
      /** The first claim's materialization committed; the worker died before the request froze. */
      const materializedThenCrashed = async () => {
        const h = autoHarness();
        expect(await h.materializeAuto(SEND_IDS.heldReply)).toEqual({ ok: true, messageId: SEND_IDS.autoMessage });
        h.materializeAuto.mockClear();
        expect(h.onlyIntent()).toMatchObject({ trigger: "auto_reply", state: "queued", request: null });
        return h;
      };

      it("sends it on re-claim while its automatic authority still holds", async () => {
        const h = await materializedThenCrashed();

        await h.deliverAuto(2);

        expect(h.materializeAuto).not.toHaveBeenCalled();
        expect(h.driver.send).toHaveBeenCalledOnce();
        expect(h.onlyIntent()).toMatchObject({ state: "accepted" });
      });

      it.each([
        ["a teammate took the conversation over", (h: Awaited<ReturnType<typeof materializedThenCrashed>>) => {
          h.owners.set(SEND_IDS.conversation, { state: "human_owned", version: 1 });
        }, "human_owned"],
        ["the mailbox dropped to draft", (h: Awaited<ReturnType<typeof materializedThenCrashed>>) => {
          h.mailboxes.seed({ ...h.mailbox, engagementMode: "draft", policyVersion: h.mailbox.policyVersion + 1 });
        }, "policy_changed"],
        ["the thread's budget was lowered below its reservation", (h: Awaited<ReturnType<typeof materializedThenCrashed>>) => {
          h.mailboxes.seed({ ...h.mailbox, engagementMode: "auto", threadSendBudget: 1 });
        }, "send_budget"],
      ] as const)("never sends it once %s, and flags the unsent reply for a teammate", async (_label, revoke, code) => {
        const h = await materializedThenCrashed();
        revoke(h);

        await h.deliverAuto(2);

        expect(h.driver.send).not.toHaveBeenCalled();
        expect(h.onlyIntent()).toMatchObject({ trigger: "auto_reply", state: "failed", failureCode: code, request: null, haltReason: null });
        expect(h.failures.openFor(SEND_IDS.autoMessage)).toMatchObject({ kind: "failed", detailCode: code, provider: "email" });
        expect(h.logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ sendIntentId: h.onlyIntent().id, conversationId: SEND_IDS.conversation, code }),
          "email_auto_send_revoked_before_send",
        );

        // A redelivery finds it settled and sends nothing.
        await h.deliverAuto(3);
        expect(h.driver.send).not.toHaveBeenCalled();
      });

      it("never fails it on a revocation read before another claim froze it: the claim that froze it sends it (research B18)", async () => {
        const h = await materializedThenCrashed();
        const call = heldProviderCall(h);
        const claims: Promise<void>[] = [];
        const readMailbox = h.mailboxes.findById.bind(h.mailboxes);
        vi.spyOn(h.mailboxes, "findById").mockImplementationOnce(async (mailboxId) => {
          // Claim A has read the intent unfrozen and stalls. Its lease runs out; claim B freezes the
          // request and enters the provider call; then a teammate takes the conversation over.
          claims.push(h.deliverAuto(3));
          await call.entered;
          h.owners.set(SEND_IDS.conversation, { state: "human_owned", version: 1 });
          return readMailbox(mailboxId);
        });

        await expect(h.deliverAuto(2)).rejects.toThrow(FROZEN_ELSEWHERE);

        expect(h.onlyIntent()).toMatchObject({ state: "queued", failureCode: null });
        expect(h.onlyIntent().request).not.toBeNull();
        expect(h.failures.rows).toEqual([]);
        expect(h.logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ sendIntentId: h.onlyIntent().id, conversationId: SEND_IDS.conversation }),
          "email_send_left_to_freezing_claim",
        );
        expect(h.logger.warn).not.toHaveBeenCalledWith(expect.anything(), "email_auto_send_revoked_before_send");

        call.release();
        await Promise.all(claims);

        expect(h.driver.send).toHaveBeenCalledOnce();
        expect(h.onlyIntent()).toMatchObject({ state: "accepted", providerMessageId: "re_provider_frozen_by_b", failureCode: null });
        expect(h.failures.rows).toEqual([]);
      });

      it("halts it, as any send, when its mailbox can no longer send as its address", async () => {
        const h = await materializedThenCrashed();
        h.domains.seed({ ...h.domain, sendingStatus: "pending" });

        await h.deliverAuto(2);

        expect(h.driver.send).not.toHaveBeenCalled();
        expect(h.onlyIntent()).toMatchObject({ state: "halted", haltReason: "sending_not_verified" });
      });
    });

    it("after materialization, a frozen request whose authority was then revoked becomes uncertain: never halted, never a draft again", async () => {
      const h = autoHarness();
      h.driver.send.mockRejectedValueOnce(new EmailSendError("retryable", "rate_limited"));
      await expect(h.deliverAuto()).rejects.toThrow();

      // A teammate takes the conversation over after the request may have reached the provider.
      h.owners.set(SEND_IDS.conversation, { state: "human_owned", version: 1 });
      await h.deliverAuto(2);

      expect(h.onlyIntent()).toMatchObject({ trigger: "auto_reply", state: "uncertain", haltReason: null });
      expect(h.driver.send).toHaveBeenCalledOnce();
      expect(h.materializeAuto).toHaveBeenCalledOnce();
      expect(h.autoReply.state).toBe("released");
      expect(h.failures.openFor(SEND_IDS.autoMessage)).toMatchObject({ kind: "uncertain" });
    });

    it("after an unknown outcome and a downgrade, the reconciler makes the send uncertain instead of re-POSTing it", async () => {
      const h = autoHarness();
      h.driver.send.mockRejectedValueOnce(new EmailSendError("unknown", "timeout"));
      await h.deliverAuto();
      expect(h.onlyIntent()).toMatchObject({ state: "queued", outcomeUnknown: true });

      h.mailboxes.seed({ ...h.mailbox, engagementMode: "draft", policyVersion: h.mailbox.policyVersion + 1 });
      h.advance(5 * 60 * 1000);
      expect(await h.reconciler.run({ maxJobs: 5 })).toMatchObject({ claimed: 1, uncertain: 1, reposted: 0 });

      expect(h.onlyIntent()).toMatchObject({ state: "uncertain" });
      expect(h.driver.send).toHaveBeenCalledOnce();
      expect(h.materializeAuto).toHaveBeenCalledOnce();
      expect(h.autoReply.state).toBe("released");
      expect(h.failures.openFor(SEND_IDS.autoMessage)).toMatchObject({ kind: "uncertain" });
    });

    it("re-POSTs an automatic send after an unknown outcome while its automatic authority still holds", async () => {
      const h = autoHarness();
      h.driver.send.mockRejectedValueOnce(new EmailSendError("unknown", "timeout"));
      await h.deliverAuto();

      h.advance(5 * 60 * 1000);
      expect(await h.reconciler.run({ maxJobs: 5 })).toMatchObject({ reposted: 1 });

      expect(h.onlyIntent()).toMatchObject({ state: "accepted" });
      expect(h.driver.send).toHaveBeenCalledTimes(2);
    });

    it("opens no failure when the outbox gives up on an automatic send that never materialized", async () => {
      const h = autoHarness();
      h.materializeAuto.mockRejectedValue(new Error("database unavailable"));
      await expect(h.deliverAuto()).rejects.toThrow("database unavailable");

      await h.handler.recordFailureOutcome({ ...h.autoAction(5), outcome: "failed", error: "database unavailable" });

      expect(h.failures.rows).toEqual([]);
      expect(h.intents.rows.size).toBe(0);
    });
  });

  describe("held_release", () => {
    const release = { payload: { trigger: "held_release" as const, heldReplyId: SEND_IDS.heldReply } };

    it("sends an unchanged release as the agent's message, with Auto-Submitted: auto-generated (FR-034)", async () => {
      const h = createSendPathHarness();
      h.messages.set(SEND_IDS.message, { ...h.messages.get(SEND_IDS.message)!, source: "ai_agent" });

      await h.deliver(release);

      expect(h.onlyIntent()).toMatchObject({ trigger: "held_release", heldReplyId: SEND_IDS.heldReply, authorKind: "agent" });
      expect(h.sentMessages[0]?.threading?.autoSubmitted).toBe("auto-generated");
    });

    it("sends an edited release as the teammate's own message, without the header", async () => {
      const h = createSendPathHarness();
      h.messages.set(SEND_IDS.message, { ...h.messages.get(SEND_IDS.message)!, source: "human_agent" });

      await h.deliver(release);

      expect(h.onlyIntent()).toMatchObject({ trigger: "held_release", authorKind: "operator" });
      expect(h.sentMessages[0]?.threading?.autoSubmitted).toBeNull();
    });

    it("renews the thread's automatic-send budget when the release's send materializes, once (research B8)", async () => {
      const h = createSendPathHarness();
      h.messages.set(SEND_IDS.message, { ...h.messages.get(SEND_IDS.message)!, source: "ai_agent" });
      const link = h.threads.links.get(SEND_IDS.conversation)!;
      h.threads.links.set(SEND_IDS.conversation, { ...link, autoSendsSinceRenewal: 3, budgetRenewedAt: null });

      await h.deliver(release);
      expect(h.threads.links.get(SEND_IDS.conversation)).toMatchObject({ autoSendsSinceRenewal: 0, budgetRenewedAt: h.clock() });

      h.threads.links.set(SEND_IDS.conversation, { ...h.threads.links.get(SEND_IDS.conversation)!, autoSendsSinceRenewal: 1 });
      await h.deliver({ ...release, context: { attempt: 2 } });
      expect(h.threads.links.get(SEND_IDS.conversation)?.autoSendsSinceRenewal).toBe(1);
    });

    it("halts a release whose mailbox can no longer send as its address, before any provider call", async () => {
      const h = createSendPathHarness();
      h.domains.seed({ ...h.domain, sendingStatus: "pending" });

      await h.deliver(release);

      expect(h.onlyIntent()).toMatchObject({ trigger: "held_release", state: "halted", haltReason: "sending_not_verified" });
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

    it("leaves a request another claim froze first to that claim, never posting it alongside (research B18)", async () => {
      const h = createSendPathHarness();
      const call = heldProviderCall(h);
      const claims: Promise<void>[] = [];
      h.intents.beforeWrite = async () => {
        // Claim A is about to freeze the request it read unfrozen; claim B freezes it first and posts it.
        h.intents.beforeWrite = null;
        claims.push(h.deliver({ context: { attempt: 2 } }));
        await call.entered;
      };

      await expect(h.deliver()).rejects.toThrow(FROZEN_ELSEWHERE);
      call.release();
      await Promise.all(claims);

      expect(h.driver.send).toHaveBeenCalledOnce();
      expect(h.onlyIntent()).toMatchObject({ state: "accepted", providerMessageId: "re_provider_frozen_by_b" });
      expect(h.failures.rows).toEqual([]);
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

    it("makes a send another claim froze after the exhausted claim read it uncertain, never failed: it may have gone out", async () => {
      const h = createSendPathHarness();
      const link = h.threads.links.get(SEND_IDS.conversation)!;
      h.threads.links.delete(SEND_IDS.conversation);
      await expect(h.deliver()).rejects.toThrow("email_send_thread_not_found");
      h.threads.links.set(SEND_IDS.conversation, link);
      const call = heldProviderCall(h);
      const claims: Promise<void>[] = [];
      h.intents.beforeWrite = async () => {
        // The exhausted claim read the request unfrozen; a stale claim freezes it and posts it first.
        h.intents.beforeWrite = null;
        claims.push(h.deliver({ context: { attempt: 4 } }));
        await call.entered;
      };

      await exhaust(h);

      expect(h.onlyIntent()).toMatchObject({ state: "uncertain", outcomeUnknown: true, failureCode: null });
      expect(h.failures.openFor(SEND_IDS.message)).toMatchObject({ kind: "uncertain" });
      call.release();
      await Promise.all(claims);
      expect(h.driver.send).toHaveBeenCalledOnce();
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
