import { describe, expect, it, vi } from "vitest";

import { emailSendKey } from "../../../src/modules/emailChannel/public.js";
import { EmailLookupError, EmailSendError, type SentEmailStatus } from "../../../src/modules/mail/public.js";
import { createSendPathHarness, SEND_IDS } from "../../support/inMemoryEmailSend.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const lookupResult = (lastEvent: SentEmailStatus["lastEvent"], deliveredMessageId: string | null = null): SentEmailStatus => ({
  providerMessageId: "re_provider_1",
  deliveredMessageId: deliveredMessageId as SentEmailStatus["deliveredMessageId"],
  lastEvent,
});

/** A send whose first attempt timed out: queued, its re-POST due in five minutes. */
const unknownOutcome = async () => {
  const h = createSendPathHarness();
  h.driver.send.mockRejectedValueOnce(new EmailSendError("unknown", "timeout"));
  await h.deliver();
  expect(h.onlyIntent()).toMatchObject({ state: "queued", outcomeUnknown: true });
  return h;
};

describe("SendReconciler", () => {
  describe("claims", () => {
    it("claims nothing before an intent is due", async () => {
      const h = await unknownOutcome();
      h.advance(4 * MINUTE);

      expect((await h.reconciler.run({ maxJobs: 5 })).claimed).toBe(0);
      expect(h.driver.send).toHaveBeenCalledOnce();
    });

    it("leases what it claims, so a concurrent sweep never claims the same intent", async () => {
      const h = createSendPathHarness();
      await h.deliver();
      h.advance(DAY);
      h.driver.lookup.mockClear();
      let releaseLookup: (status: SentEmailStatus) => void = () => undefined;
      h.driver.lookup.mockImplementationOnce(() => new Promise((resolve) => {
        releaseLookup = resolve;
      }));

      const first = h.reconciler.run({ maxJobs: 5 });
      await vi.waitFor(() => expect(h.driver.lookup).toHaveBeenCalledOnce());
      const second = await h.reconciler.run({ maxJobs: 5 });
      releaseLookup(lookupResult("delivered"));

      expect(second.claimed).toBe(0);
      expect((await first).settled).toBe(1);
      expect(h.onlyIntent().state).toBe("delivered");
      expect(h.driver.lookup).toHaveBeenCalledOnce();
    });

    it("leaves a claim that ended without a transition to run out, then claims it again", async () => {
      const h = createSendPathHarness();
      await h.deliver();
      h.advance(DAY);
      h.driver.lookup.mockRejectedValueOnce(new EmailLookupError(true, "unavailable"));

      expect(await h.reconciler.run({ maxJobs: 5 })).toMatchObject({ claimed: 1, deferred: 1 });
      expect((await h.reconciler.run({ maxJobs: 5 })).claimed).toBe(0);

      h.advance(5 * MINUTE + 1);
      h.driver.lookup.mockResolvedValueOnce(lookupResult("delivered"));
      expect(await h.reconciler.run({ maxJobs: 5 })).toMatchObject({ claimed: 1, settled: 1 });
    });
  });

  describe("re-POST after an unknown outcome", () => {
    it("re-POSTs the frozen request under the same key inside the 23-hour window", async () => {
      const h = await unknownOutcome();
      h.advance(5 * MINUTE);

      expect(await h.reconciler.run({ maxJobs: 5 })).toMatchObject({ claimed: 1, reposted: 1 });

      const [[first], [second]] = h.driver.send.mock.calls;
      expect(second).toEqual(first);
      expect(second?.idempotencyKey).toBe(emailSendKey.message(SEND_IDS.message));
      expect(h.onlyIntent()).toMatchObject({ state: "accepted", providerMessageId: "re_provider_1" });
      expect(h.intents.rows.size).toBe(1);
      expect(h.counted("email_send_reconciliations_total")).toEqual([{ action: "repost", result: "reposted" }]);
    });

    it("schedules the next re-POST when the outcome is unknown again", async () => {
      const h = await unknownOutcome();
      h.advance(5 * MINUTE);
      h.driver.send.mockRejectedValueOnce(new EmailSendError("unknown", "unreachable"));

      await h.reconciler.run({ maxJobs: 5 });

      expect(h.onlyIntent()).toMatchObject({ state: "queued", nextReconcileAt: new Date(h.clock().getTime() + 5 * MINUTE) });
      expect(h.drains.requestDrain).toHaveBeenLastCalledWith({ maxJobs: 5, stage: "reconcile", scheduleAt: h.onlyIntent().nextReconcileAt });
    });

    it("does not re-POST once authority is revoked: the send becomes uncertain and flags the message", async () => {
      const h = await unknownOutcome();
      h.domains.seed({ ...h.domain, removedAt: h.clock() });
      h.advance(5 * MINUTE);

      expect(await h.reconciler.run({ maxJobs: 5 })).toMatchObject({ claimed: 1, uncertain: 1 });

      expect(h.driver.send).toHaveBeenCalledOnce();
      expect(h.onlyIntent()).toMatchObject({ state: "uncertain", haltReason: null, nextReconcileAt: null });
      expect(h.failures.openFor(SEND_IDS.message)?.kind).toBe("uncertain");
    });

    it("does not re-POST past the window: the key may no longer be honoured", async () => {
      const h = await unknownOutcome();
      h.advance(23 * HOUR);

      await h.reconciler.run({ maxJobs: 5 });

      expect(h.driver.send).toHaveBeenCalledOnce();
      expect(h.onlyIntent().state).toBe("uncertain");
    });

    it("defers a re-POST the provider asks to repeat, keeping the send queued", async () => {
      const h = await unknownOutcome();
      h.advance(5 * MINUTE);
      h.driver.send.mockRejectedValueOnce(new EmailSendError("retryable", "rate_limited"));

      expect(await h.reconciler.run({ maxJobs: 5 })).toMatchObject({ deferred: 1 });
      expect(h.onlyIntent()).toMatchObject({ state: "queued", outcomeUnknown: true });
    });
  });

  describe("lookup after 24 hours", () => {
    it.each([
      ["delivered", "delivered"],
      ["bounced", "bounced"],
      ["suppressed", "bounced"],
      ["failed", "failed"],
    ] as const)("settles %s from the provider's evidence", async (lastEvent, state) => {
      const h = createSendPathHarness();
      await h.deliver();
      h.advance(DAY);
      h.driver.lookup.mockResolvedValueOnce(lookupResult(lastEvent));

      expect(await h.reconciler.run({ maxJobs: 5 })).toMatchObject({ claimed: 1, settled: 1 });

      expect(h.onlyIntent().state).toBe(state);
      expect(h.driver.send).toHaveBeenCalledOnce();
    });

    it.each([
      ["no provider record", null],
      ["an unsettled status", lookupResult("sent")],
      ["a delayed delivery", lookupResult("delivery_delayed")],
    ] as const)("makes the send uncertain on %s, never resending it", async (_label, result) => {
      const h = createSendPathHarness();
      await h.deliver();
      h.advance(DAY);
      h.driver.lookup.mockResolvedValueOnce(result);

      expect(await h.reconciler.run({ maxJobs: 5 })).toMatchObject({ uncertain: 1 });

      expect(h.onlyIntent()).toMatchObject({ state: "uncertain", nextReconcileAt: null });
      expect(h.failures.openFor(SEND_IDS.message)?.kind).toBe("uncertain");
      expect(h.driver.send).toHaveBeenCalledOnce();
      expect(h.counted("email_send_intents_total")).toContainEqual({ trigger: "operator_reply", state: "uncertain" });
    });

    it("records the delivered Message-Id the lookup reports", async () => {
      const h = createSendPathHarness();
      await h.deliver();
      h.advance(DAY);
      h.driver.lookup.mockResolvedValueOnce(lookupResult("delivered", "<ses-9@email.amazonses.com>"));

      await h.reconciler.run({ maxJobs: 5 });

      expect(h.onlyIntent()).toMatchObject({ state: "delivered", deliveredRfcMessageId: "<ses-9@email.amazonses.com>" });
      expect(h.threads.index).toContainEqual(expect.objectContaining({ rfcMessageId: "<ses-9@email.amazonses.com>", origin: "provider_delivered" }));
    });
  });
});
