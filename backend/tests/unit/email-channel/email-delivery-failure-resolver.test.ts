import { describe, expect, it, vi } from "vitest";

import type { DeliveryFailureRecord } from "../../../src/modules/customerReplyDelivery/public.js";
import { emailSendActionPayloadSchema } from "../../../src/modules/emailChannel/outbound/emailSendAction.js";
import { EmailDeliveryFailureResolver, emailSendKey } from "../../../src/modules/emailChannel/public.js";
import { createSendPathHarness, SEND_IDS } from "../../support/inMemoryEmailSend.js";

const DAY = 24 * 60 * 60 * 1000;
const TEAMMATE = "99999999-0000-4000-8000-000000000001";

type Harness = ReturnType<typeof createSendPathHarness>;
type QueuedAction = { type: string; idempotencyKey?: string | null; payload: Record<string, unknown>; workspaceId?: string | null };

/** The resolver over the send-path harness, its unit of work rolling back every store on a throw. */
const resolverFor = (h: Harness) => {
  const actions: QueuedAction[] = [];
  const outbox = {
    enqueue: vi.fn(async (input: QueuedAction) => {
      const duplicate = actions.some((action) => action.idempotencyKey === input.idempotencyKey);
      if (!duplicate) actions.push(structuredClone(input));
      return { id: `action-${actions.length}`, duplicate };
    }),
  };
  const scope = { intents: h.intents, failures: h.failures, outbox };
  const unitOfWork = {
    async run<T>(work: (unit: typeof scope) => Promise<T>): Promise<T> {
      const intents = new Map([...h.intents.rows].map(([id, row]) => [id, structuredClone(row)]));
      const failures = structuredClone(h.failures.rows);
      const queued = actions.length;
      try {
        return await work(scope);
      } catch (error) {
        h.intents.rows.clear();
        for (const [id, row] of intents) h.intents.rows.set(id, row);
        h.failures.rows.splice(0, h.failures.rows.length, ...failures);
        actions.splice(queued);
        throw error;
      }
    },
  };
  const resolver = new EmailDeliveryFailureResolver({
    intents: h.intents,
    mailboxes: h.mailboxes,
    domains: h.domains,
    ownership: { versionOf: async () => 3 },
    unitOfWork,
    metrics: h.metrics,
  });
  /** The message's open failure, as a teammate's request read it. */
  const openFailure = (): DeliveryFailureRecord => {
    const row = h.failures.openFor(SEND_IDS.message);
    if (!row) throw new Error("no open failure on the message");
    return h.failures.recordOf(row);
  };
  const resolve = (decision: "marked_sent" | "resend", failure: DeliveryFailureRecord = openFailure()) =>
    resolver.resolve({ workspaceId: SEND_IDS.workspace, failure, decision, userId: TEAMMATE });
  return { resolver, actions, outbox, resolve, openFailure };
};

/** A send no evidence settled within a day: `uncertain`, its failure open. */
const uncertain = async () => {
  const h = createSendPathHarness();
  await h.deliver();
  h.advance(DAY);
  await h.reconciler.run({ maxJobs: 5 });
  expect(h.onlyIntent().state).toBe("uncertain");
  return h;
};

/** A send halted before its first attempt because the domain lost verification. */
const halted = async () => {
  const h = createSendPathHarness({ sendingStatus: "pending" });
  await h.deliver();
  expect(h.onlyIntent().state).toBe("halted");
  return h;
};

describe("EmailDeliveryFailureResolver", () => {
  describe("marked_sent", () => {
    it("settles an uncertain send as sent and clears its failure as operator_resolved, queuing nothing", async () => {
      const h = await uncertain();
      const r = resolverFor(h);

      expect(await r.resolve("marked_sent")).toEqual({ sendIntentId: h.onlyIntent().id });

      expect(h.onlyIntent()).toMatchObject({ state: "uncertain", uncertainResolution: "marked_sent", uncertainResolvedByUserId: TEAMMATE });
      expect(h.failures.openFor(SEND_IDS.message)).toBeUndefined();
      expect(h.failures.rows[0]?.cleared).toBe("operator_resolved");
      expect(r.actions).toEqual([]);
    });

    it("refuses a halted send, which never reached the provider, writing nothing", async () => {
      const h = await halted();
      const r = resolverFor(h);

      await expect(r.resolve("marked_sent")).rejects.toMatchObject({ statusCode: 409, code: "not_resolvable" });
      expect(h.onlyIntent().uncertainResolution).toBeNull();
      expect(h.failures.openFor(SEND_IDS.message)?.kind).toBe("halted");
    });
  });

  describe("resend", () => {
    it("queues exactly one new email.send under the first resend key, and never the original key", async () => {
      const h = await uncertain();
      const r = resolverFor(h);
      const original = h.onlyIntent();

      expect(await r.resolve("resend")).toEqual({ sendIntentId: original.id });

      expect(r.actions).toHaveLength(1);
      const [queued] = r.actions;
      expect(queued).toMatchObject({ type: "email.send", workspaceId: SEND_IDS.workspace, idempotencyKey: emailSendKey.resend(SEND_IDS.message, 1) });
      expect(queued?.idempotencyKey).not.toBe(original.idempotencyKey);
      expect(emailSendActionPayloadSchema.parse(queued?.payload)).toEqual({
        version: 1,
        trigger: "audited_resend",
        mailboxId: h.mailbox.id,
        conversationId: SEND_IDS.conversation,
        messageId: SEND_IDS.message,
        heldReplyId: null,
        authority: { policyVersion: 1, ownershipVersion: 3, mode: "operator_only", domainId: h.domain.id },
      });
      expect(h.intents.rows.get(original.id)).toMatchObject({ state: "uncertain", uncertainResolution: "resend_authorized", uncertainResolvedByUserId: TEAMMATE });
      expect(h.failures.rows[0]?.cleared).toBe("operator_resolved");
    });

    it("is delivered by the handler as a new send of the same message, with its own key and Message-Id", async () => {
      const h = await uncertain();
      const r = resolverFor(h);
      await r.resolve("resend");
      const [queued] = r.actions;

      await h.handler.handle({ payload: queued.payload, context: h.context({ idempotencyKey: queued.idempotencyKey ?? null }) });

      const chain = await h.intents.listByMessageId(SEND_IDS.message);
      expect(chain.map((sent) => [sent.trigger, sent.state])).toEqual([["operator_reply", "uncertain"], ["audited_resend", "accepted"]]);
      const [[first], [second]] = h.driver.send.mock.calls;
      expect(second?.idempotencyKey).toBe(emailSendKey.resend(SEND_IDS.message, 1));
      expect(second?.threading?.messageId).not.toBe(first?.threading?.messageId);
      expect(second?.text).toBe(first?.text);
    });

    it("numbers each resend of a message after the ones before it", async () => {
      const h = await halted();
      const r = resolverFor(h);
      h.domains.seed({ ...h.domain, sendingStatus: "verified" });
      await r.resolve("resend");
      // The first resend halts in turn: the domain lost verification again before it was sent.
      h.domains.seed({ ...h.domain, sendingStatus: "pending" });
      await h.handler.handle({ payload: r.actions[0].payload, context: h.context({ idempotencyKey: r.actions[0].idempotencyKey ?? null }) });
      h.domains.seed({ ...h.domain, sendingStatus: "verified" });

      await r.resolve("resend");

      expect(r.actions.map((action) => action.idempotencyKey)).toEqual([
        emailSendKey.resend(SEND_IDS.message, 1),
        emailSendKey.resend(SEND_IDS.message, 2),
      ]);
    });

    it("refuses with 409 email_sending_not_verified, naming the step, before any write while the mailbox cannot send", async () => {
      const h = await halted();
      const r = resolverFor(h);

      await expect(r.resolve("resend")).rejects.toMatchObject({
        statusCode: 409,
        code: "email_sending_not_verified",
        details: { step: "verify_sending_domain", domain: "customer.test" },
      });
      expect(h.onlyIntent().uncertainResolution).toBeNull();
      expect(h.failures.openFor(SEND_IDS.message)?.kind).toBe("halted");
      expect(r.outbox.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("fences", () => {
    it("refuses a second decision on the same send, queuing no second resend", async () => {
      const h = await uncertain();
      const r = resolverFor(h);
      const failure = r.openFailure();
      await r.resolve("resend", failure);

      await expect(r.resolve("resend", failure)).rejects.toMatchObject({ statusCode: 409, code: "not_resolvable" });
      expect(r.actions).toHaveLength(1);
    });

    it("rolls the decision back when the failure was cleared meanwhile", async () => {
      const h = await uncertain();
      const r = resolverFor(h);
      const failure = r.openFailure();
      await h.failures.clear({ conversationId: SEND_IDS.conversation, messageIds: [SEND_IDS.message], reason: "provider_evidence" });

      await expect(r.resolve("resend", failure)).rejects.toMatchObject({ statusCode: 409, code: "not_resolvable" });
      expect(h.onlyIntent().uncertainResolution).toBeNull();
      expect(r.actions).toEqual([]);
    });

    it("refuses a stale decision on a failure a resend already replaced with a newer one, resending nothing more", async () => {
      const h = await halted();
      const r = resolverFor(h);
      h.domains.seed({ ...h.domain, sendingStatus: "verified" });
      // Two teammates read the same failure; the first resolves it.
      const read = r.openFailure();
      await r.resolve("resend", read);
      // Its resend halts in turn, opening a second failure on the same message.
      h.domains.seed({ ...h.domain, sendingStatus: "pending" });
      await h.handler.handle({ payload: r.actions[0].payload, context: h.context({ idempotencyKey: r.actions[0].idempotencyKey ?? null }) });
      h.domains.seed({ ...h.domain, sendingStatus: "verified" });
      const newer = r.openFailure();
      expect(newer.id).not.toBe(read.id);

      // The second teammate's request still names the first failure.
      await expect(r.resolve("resend", read)).rejects.toMatchObject({ statusCode: 409, code: "not_resolvable" });

      expect(r.actions).toHaveLength(1);
      expect(h.failures.openFor(SEND_IDS.message)).toMatchObject({ id: newer.id, kind: "halted", cleared: null });
      const [, resent] = await h.intents.listByMessageId(SEND_IDS.message);
      expect(resent).toMatchObject({ trigger: "audited_resend", state: "halted", uncertainResolution: null });
    });

    it("refuses a decision made on a failure whose kind changed since it was read", async () => {
      const h = await uncertain();
      const r = resolverFor(h);
      const read = r.openFailure();
      await h.failures.retarget({ conversationId: SEND_IDS.conversation, messageId: SEND_IDS.message, kind: "bounced", detailCode: "5.1.1" });

      await expect(r.resolve("marked_sent", read)).rejects.toMatchObject({ statusCode: 409, code: "not_resolvable" });
      expect(h.onlyIntent().uncertainResolution).toBeNull();
    });

    it("re-applies the decision to an intent another writer moved first", async () => {
      const h = await uncertain();
      const r = resolverFor(h);
      const intent = h.onlyIntent();
      h.intents.beforeWrite = async () => {
        h.intents.beforeWrite = null;
        await h.intents.recordComplaint(intent.id);
      };

      await r.resolve("marked_sent");

      expect(h.onlyIntent().uncertainResolution).toBe("marked_sent");
      expect(h.counted("email_send_transition_conflicts_total")).toEqual([{ writer: "operator" }]);
    });

    it.each([
      ["another channel's failure", { provider: "slack" }],
      ["a failure that names no message", { messageId: null }],
      ["another workspace's send", { workspaceId: "22222222-2222-4222-8222-222222222222" }],
    ])("refuses %s", async (_label, patch) => {
      const h = await uncertain();
      const r = resolverFor(h);
      const failure = { ...r.openFailure(), ...patch };

      await expect(r.resolver.resolve({ workspaceId: failure.workspaceId, failure, decision: "marked_sent", userId: TEAMMATE }))
        .rejects.toMatchObject({ code: "not_resolvable" });
    });
  });
});
