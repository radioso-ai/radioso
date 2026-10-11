import { describe, expect, it } from "vitest";

import { emailSendKey } from "../../../src/modules/emailChannel/public.js";
import { bounceDetailCode } from "../../../src/modules/emailChannel/outbound/providerDeliveryEvents.js";
import type { DeliveryStatusFacts } from "../../../src/modules/mail/public.js";
import { createSendPathHarness, SEND_IDS } from "../../support/inMemoryEmailSend.js";

const DAY = 24 * 60 * 60 * 1000;
const PROVIDER_ID = "re_provider_1";

const status = (type: DeliveryStatusFacts["type"], bounce: DeliveryStatusFacts["bounce"] = null): DeliveryStatusFacts => ({ type, bounce });

/** A send the provider accepted, as the handler leaves it. */
const accepted = async () => {
  const h = createSendPathHarness();
  await h.deliver();
  return h;
};

/** A send no evidence settled within a day: the reconciler's lookup made it `uncertain`. */
const uncertain = async () => {
  const h = await accepted();
  h.advance(DAY);
  await h.reconciler.run({ maxJobs: 5 });
  expect(h.onlyIntent().state).toBe("uncertain");
  return h;
};

const webhook = (h: ReturnType<typeof createSendPathHarness>, facts: DeliveryStatusFacts, providerMessageId = PROVIDER_ID) =>
  h.deliveryEvents.applyStatus({ provider: "resend", providerMessageId, status: facts });

describe("ProviderDeliveryEvents", () => {
  describe("provider statuses on an accepted send", () => {
    it("settles delivered", async () => {
      const h = await accepted();

      expect(await webhook(h, status("delivered"))).toBe("applied");

      expect(h.onlyIntent()).toMatchObject({ state: "delivered", settledAt: h.clock(), nextReconcileAt: null });
      expect(h.onlyIntent().request?.body).toBeNull();
      expect(h.failures.rows).toEqual([]);
    });

    it("bounces with the sanitized type, subtype and enhanced status code, and flags the message", async () => {
      const h = await accepted();

      await webhook(h, status("bounced", { type: "Permanent", subType: "General", statusCode: "5.1.1" }));

      expect(h.onlyIntent()).toMatchObject({ state: "bounced", failureCode: "Permanent:General:5.1.1" });
      expect(h.failures.openFor(SEND_IDS.message)).toMatchObject({ kind: "bounced", detailCode: "Permanent:General:5.1.1", provider: "email" });
    });

    it("bounces a suppressed recipient", async () => {
      const h = await accepted();

      await webhook(h, status("suppressed", { type: "OnAccountSuppressionList", subType: null, statusCode: null }));

      expect(h.onlyIntent()).toMatchObject({ state: "bounced", failureCode: "OnAccountSuppressionList" });
    });

    it("fails a send the provider failed", async () => {
      const h = await accepted();

      await webhook(h, status("failed"));

      expect(h.onlyIntent()).toMatchObject({ state: "failed", failureCode: "failed" });
      expect(h.failures.openFor(SEND_IDS.message)?.kind).toBe("failed");
    });

    it.each(["sent", "delivery_delayed"] as const)("only counts %s", async (type) => {
      const h = await accepted();

      expect(await webhook(h, status(type))).toBe("ignored");

      expect(h.onlyIntent().state).toBe("accepted");
      expect(h.counted("email_send_provider_events_total")).toEqual([{ status: type, source: "webhook", outcome: "ignored" }]);
    });

    it("records a complaint once, audited, without changing the delivery state", async () => {
      const h = await accepted();

      expect(await webhook(h, status("complained"))).toBe("applied");
      expect(await webhook(h, status("complained"))).toBe("ignored");

      expect(h.onlyIntent()).toMatchObject({ state: "accepted", complainedAt: h.clock() });
      expect(h.audit.record).toHaveBeenCalledOnce();
      expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: SEND_IDS.workspace,
        eventType: "email_channel.send",
        metadata: expect.objectContaining({ action: "complained", sendIntentId: h.onlyIntent().id }),
      }));
    });
  });

  describe("a later delivery on the conversation (later_delivery)", () => {
    const MINUTE = 60 * 1000;
    /** Sends another reply on the conversation, accepted under its own provider id. */
    const sendReply = async (h: ReturnType<typeof createSendPathHarness>, messageId: string, providerMessageId: string) => {
      h.advance(MINUTE);
      h.messages.set(messageId, { id: messageId, conversationId: SEND_IDS.conversation, content: "Another reply.", source: "human_agent" });
      h.driver.send.mockResolvedValueOnce({ dispatched: true, providerMessageId, deliveredMessageId: null });
      await h.deliver({ payload: { messageId }, context: { idempotencyKey: emailSendKey.message(messageId) } });
    };
    const LATER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const NEWER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    it("clears the failures of earlier replies when a later one is delivered, and never a newer reply's", async () => {
      const h = await accepted();
      await sendReply(h, LATER, "re_provider_2");
      await sendReply(h, NEWER, "re_provider_3");
      await webhook(h, status("bounced"), PROVIDER_ID);
      await webhook(h, status("bounced"), "re_provider_3");
      expect(h.failures.openFor(SEND_IDS.message)?.kind).toBe("bounced");
      expect(h.failures.openFor(NEWER)?.kind).toBe("bounced");

      // The reply between them reaches the customer: the earlier bounce no longer needs anyone.
      await webhook(h, status("delivered"), "re_provider_2");

      expect(h.failures.openFor(SEND_IDS.message)).toBeUndefined();
      expect(h.failures.rows.find((row) => row.messageId === SEND_IDS.message)).toMatchObject({ cleared: "later_delivery" });
      // The newer reply went out after it, so its bounce still stands.
      expect(h.failures.openFor(NEWER)).toMatchObject({ kind: "bounced", cleared: null });
    });
  });

  it("ignores events about mail it did not send", async () => {
    const h = await accepted();

    expect(await webhook(h, status("bounced"), "re_transactional_9")).toBe("foreign");
    expect(await h.deliveryEvents.applyStatus({ provider: "local", providerMessageId: PROVIDER_ID, status: status("bounced") })).toBe("foreign");

    expect(h.onlyIntent().state).toBe("accepted");
    expect(h.counted("email_send_provider_events_total")).toContainEqual({ status: "bounced", source: "webhook", outcome: "foreign" });
  });

  describe("out-of-order and repeated events", () => {
    it("never regresses a settled send", async () => {
      const h = await accepted();

      await webhook(h, status("delivered"));
      expect(await webhook(h, status("sent"))).toBe("ignored");
      expect(await webhook(h, status("bounced", { type: "Permanent", subType: null, statusCode: null }))).toBe("ignored");
      expect(await webhook(h, status("delivered"))).toBe("ignored");

      expect(h.onlyIntent()).toMatchObject({ state: "delivered", failureCode: null });
      expect(h.failures.rows).toEqual([]);
    });

    it("logs each event it drops at info with the intent, the event and the state it found, never the event's content", async () => {
      const h = await accepted();
      await webhook(h, status("delivered"));
      const intent = h.onlyIntent();

      expect(await webhook(h, status("bounced", { type: "Permanent", subType: "General", statusCode: "5.1.1" }))).toBe("ignored");

      expect(h.logger.info).toHaveBeenCalledWith({
        sendIntentId: intent.id,
        workspaceId: SEND_IDS.workspace,
        conversationId: SEND_IDS.conversation,
        writer: "webhook",
        attempt: null,
        event: "provider_status",
        status: "bounced",
        source: "webhook",
        state: "delivered",
        reason: "terminal",
      }, "email_send_event_ignored");
    });

    it("logs a repeated complaint it drops at info, by intent", async () => {
      const h = await accepted();
      expect(await webhook(h, status("complained"))).toBe("applied");

      expect(await webhook(h, status("complained"))).toBe("ignored");

      expect(h.logger.info).toHaveBeenCalledWith(
        { sendIntentId: h.onlyIntent().id, workspaceId: SEND_IDS.workspace, conversationId: SEND_IDS.conversation, event: "complained", reason: "already_recorded" },
        "email_send_event_ignored",
      );
    });

    it("re-applies an event to the intent another writer moved first, and drops it once the send is settled", async () => {
      const h = await accepted();
      const competing = h.onlyIntent();
      h.intents.beforeWrite = async () => {
        h.intents.beforeWrite = null;
        await h.writer.apply(competing, { kind: "provider_status", status: "delivered", source: "lookup" }, { writer: "reconciler" });
      };

      expect(await webhook(h, status("bounced"))).toBe("ignored");

      expect(h.onlyIntent().state).toBe("delivered");
      expect(h.counted("email_send_transition_conflicts_total")).toEqual([{ writer: "webhook" }]);
    });
  });

  describe("an inbound delivery status report", () => {
    it("bounces the send behind a Radioso Message-Id it names", async () => {
      const h = await accepted();

      const applied = await h.deliveryEvents.applyDsnBounce({ mailboxId: h.mailbox.id, rfcMessageIds: [h.onlyIntent().suppliedRfcMessageId] });

      expect(applied).toBe(1);
      expect(h.onlyIntent()).toMatchObject({ state: "bounced", failureCode: "bounced" });
      expect(h.failures.openFor(SEND_IDS.message)?.kind).toBe("bounced");
      expect(h.counted("email_send_provider_events_total")).toEqual([{ status: "bounced", source: "dsn", outcome: "applied" }]);
    });

    it("ignores ids that are not the mailbox's outbound mail", async () => {
      const h = await accepted();

      expect(await h.deliveryEvents.applyDsnBounce({ mailboxId: h.mailbox.id, rfcMessageIds: ["<second@example.org>", "<foreign@else.example>"] })).toBe(0);
      expect(await h.deliveryEvents.applyDsnBounce({ mailboxId: "00000000-0000-4000-8000-000000000000", rfcMessageIds: [h.onlyIntent().suppliedRfcMessageId] })).toBe(0);

      expect(h.onlyIntent().state).toBe("accepted");
    });
  });

  describe("late evidence on an uncertain send", () => {
    it("settles it delivered, clears the failure and audits the evidence, without any resend", async () => {
      const h = await uncertain();
      expect(h.failures.openFor(SEND_IDS.message)?.kind).toBe("uncertain");

      await webhook(h, status("delivered"));

      expect(h.onlyIntent()).toMatchObject({ state: "delivered", uncertainResolution: "provider_evidence" });
      expect(h.failures.openFor(SEND_IDS.message)).toBeUndefined();
      expect(h.failures.rows[0]?.cleared).toBe("provider_evidence");
      expect(h.driver.send).toHaveBeenCalledOnce();
      expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({
        eventType: "hitl.delivery_failure",
        metadata: expect.objectContaining({ action: "provider_evidence", sendIntentId: h.onlyIntent().id, to: "delivered" }),
      }));
    });

    it("moves the open failure to bounced on a late bounce", async () => {
      const h = await uncertain();

      await webhook(h, status("bounced", { type: "Permanent", subType: "General", statusCode: "5.1.1" }));

      expect(h.onlyIntent()).toMatchObject({ state: "bounced", uncertainResolution: "provider_evidence" });
      expect(h.failures.rows).toHaveLength(1);
      expect(h.failures.openFor(SEND_IDS.message)).toMatchObject({ kind: "bounced", detailCode: "Permanent:General:5.1.1" });
    });

    describe("after a teammate resent it, and the resend became uncertain too", () => {
      const RESEND_PROVIDER_ID = "re_provider_resend";
      const hardBounce = status("bounced", { type: "Permanent", subType: "General", statusCode: "5.1.1" });

      /** The original's doubt resolved by a resend, as the resolver leaves it, and the resend unsettled a day on. */
      const resentAndUncertain = async () => {
        const h = await uncertain();
        const original = h.onlyIntent();
        const decided = await h.writer.apply(original, { kind: "operator_resolution", decision: "resend", userId: "user-1" }, { writer: "operator" });
        expect(decided.outcome).toBe("applied");
        const opened = h.failures.openFor(SEND_IDS.message);
        await h.failures.clear({ reason: "operator_resolved", failureId: opened?.id ?? "", userId: "user-1" });
        h.driver.send.mockResolvedValueOnce({ dispatched: true, providerMessageId: RESEND_PROVIDER_ID, deliveredMessageId: null });
        await h.deliver({
          payload: { trigger: "audited_resend" },
          context: { idempotencyKey: emailSendKey.resend(SEND_IDS.message, 1) },
        });
        h.advance(DAY);
        await h.reconciler.run({ maxJobs: 5 });
        const resend = [...h.intents.rows.values()].find((intent) => intent.id !== original.id);
        expect(resend).toMatchObject({ trigger: "audited_resend", state: "uncertain", providerMessageId: RESEND_PROVIDER_ID });
        expect(h.failures.openFor(SEND_IDS.message)).toMatchObject({ kind: "uncertain" });
        return { h, original, resend: resend! };
      };

      it("records a late bounce of the original on the original only: the resend's failure stays uncertain, so still resolvable", async () => {
        const { h, original, resend } = await resentAndUncertain();
        const resendFailure = h.failures.openFor(SEND_IDS.message);

        expect(await webhook(h, hardBounce)).toBe("applied");

        expect(h.intents.rows.get(original.id)).toMatchObject({
          state: "bounced",
          failureCode: "Permanent:General:5.1.1",
          uncertainResolution: "resend_authorized",
        });
        expect(h.intents.rows.get(resend.id)).toMatchObject({ state: "uncertain", uncertainResolution: null });
        expect(h.failures.openFor(SEND_IDS.message)).toEqual(resendFailure);
        expect(h.failures.openFor(SEND_IDS.message)).toMatchObject({ kind: "uncertain", detailCode: null });
      });

      it("still settles the resend on its own late evidence", async () => {
        const { h, resend } = await resentAndUncertain();
        await webhook(h, hardBounce);

        expect(await webhook(h, hardBounce, RESEND_PROVIDER_ID)).toBe("applied");

        expect(h.intents.rows.get(resend.id)).toMatchObject({ state: "bounced", uncertainResolution: "provider_evidence" });
        expect(h.failures.openFor(SEND_IDS.message)).toMatchObject({ kind: "bounced", detailCode: "Permanent:General:5.1.1" });
      });
    });
  });
});

describe("bounceDetailCode", () => {
  it("keeps the provider's tokens and the enhanced status code only", () => {
    expect(bounceDetailCode({ type: "Permanent", subType: "General", statusCode: "5.1.1" })).toBe("Permanent:General:5.1.1");
    expect(bounceDetailCode({ type: "Transient", subType: null, statusCode: null })).toBe("Transient");
    expect(bounceDetailCode(null)).toBeNull();
  });
});
