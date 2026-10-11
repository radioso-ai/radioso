import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { emailSendKey } from "../../src/modules/emailChannel/public.js";
import { LocalEmailDriver } from "../../src/modules/mail/adapters/localEmailDriver.js";
import type { Database } from "../../src/shared/infra/database.js";
import {
  activityOf,
  barrier,
  createEmailChannelDatabase,
  createSpool,
  createWorkerNode,
  indexedMessageIdsOf,
  postDeliveryEvent,
} from "./support/emailChannelHarness.js";
import {
  counterValue,
  createApiNode,
  deliveryFailuresOf,
  expireOutboxClaims,
  makeReconcileDue,
  openEmailConversation,
  outboxActionsOf,
  providerAcceptsUnder,
  replyFromInbox,
  sendIntentOf,
} from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// The send intent's concurrency fence against Postgres (research B18): every writer (the provider
// webhook, the reconciler, the action handler) applies its event under the intent's `version`, so
// concurrent evidence lands once and the loser re-reads a settled send and drops its event. Each
// writer runs in its own worker process, with its own pool, seams and metrics.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const CONFLICTS = "email_send_transition_conflicts_total";

type WorkerNode = ReturnType<typeof createWorkerNode>;

describeIntegration("email send fencing (Postgres, research B18)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Awaited<ReturnType<typeof createSpool>>;
  let api: ReturnType<typeof createApiNode>;
  /** The provider's own record, which `lookup` reads; delivery events are recorded on it. */
  let provider: LocalEmailDriver;
  const nodes: WorkerNode[] = [];

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "send_fencing");
    database = suite.database;
    spool = await createSpool();
    api = createApiNode(database, { spoolDir: spool.dir });
    provider = new LocalEmailDriver({ spoolDir: spool.dir });
  }, 60_000);

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((node) => node.close().catch(() => undefined)));
    expect(await database.query("SELECT id FROM routine_action_requests WHERE status IN ('pending', 'in_progress')")).toEqual([]);
  });

  afterAll(async () => {
    await spool?.remove();
    await suite?.close();
  }, 30_000);

  const workerNode = (): WorkerNode => {
    const node = createWorkerNode(suite.url, { spoolDir: spool.dir });
    nodes.push(node);
    return node;
  };

  const conflictsOn = (...writers: WorkerNode[]): number =>
    writers.reduce((sum, node) => sum + counterValue(node.metrics, CONFLICTS), 0);

  /** A teammate's reply on a fresh conversation, queued for sending. */
  const queuedReply = async () => {
    const conversation = await openEmailConversation(database, { node: workerNode(), spool });
    const messageId = await replyFromInbox(database, api, conversation);
    return { ...conversation, messageId };
  };

  /** A reply the provider accepted, sent by a worker of its own. */
  const acceptedReply = async () => {
    const queued = await queuedReply();
    expect(await workerNode().dispatch()).toMatchObject({ dispatched: 1 });
    const intent = await sendIntentOf(database, queued.messageId);
    expect(intent).toMatchObject({ state: "accepted", nextReconcileAt: expect.any(Date) });
    return { ...queued, intent, providerMessageId: intent.providerMessageId ?? "" };
  };

  it("settles a send once when the delivered webhook and the reconciler's lookup race, and counts the conflict", async () => {
    const { conversationId, messageId, intent, providerMessageId } = await acceptedReply();
    await provider.recordEvent(providerMessageId, "delivered");
    await makeReconcileDue(database, intent.id);
    const [webhook, reconciler] = [workerNode(), workerNode()];
    expect(await postDeliveryEvent(await webhook.webhook(), { type: "email.delivered", providerMessageId })).toBe(200);
    // Both writers hold the intent as they read it, at the same version, before either writes.
    const bothRead = barrier(2);
    for (const node of [webhook, reconciler]) {
      node.seams.on("writer.apply", "before", async (nth) => {
        if (nth === 1) await bothRead.arrive();
      });
    }

    const [inbound, reconciled] = await Promise.all([
      webhook.worker.drain({ maxJobs: 5, stage: "inbound" }),
      reconciler.worker.drain({ maxJobs: 5, stage: "reconcile" }),
    ]);

    expect(inbound).toMatchObject({ claimed: 1, processed: 1, errored: 0 });
    expect(reconciled).toMatchObject({ reconciled: 1, claimed: 0 });
    const settled = await sendIntentOf(database, messageId);
    expect(settled).toMatchObject({ state: "delivered", version: intent.version + 1, nextReconcileAt: null, reconcileLeaseUntil: null });
    expect(conflictsOn(webhook, reconciler)).toBe(1);
    const entered = (node: WorkerNode) => counterValue(node.metrics, "email_send_intents_total", { state: "delivered" });
    expect(entered(webhook) + entered(reconciler)).toBe(1);
    expect(await deliveryFailuresOf(database, conversationId)).toEqual([]);
    expect((await activityOf(database, conversationId)).map((entry) => entry.kind)).not.toContain("delivery_failed");
  });

  it.each(["sent", "bounced"] as const)(
    "never lets a stale lookup reporting %s overwrite a delivered send",
    async (stale) => {
      const { conversationId, messageId, intent, providerMessageId } = await acceptedReply();
      await provider.recordEvent(providerMessageId, stale);
      await makeReconcileDue(database, intent.id);
      const [reconciler, webhook] = [workerNode(), workerNode()];
      // The reconciler has the provider's answer, and the intent as it was before the delivery.
      const answered = reconciler.seams.pauseAt("driver.lookup", "after");
      const reconciling = reconciler.worker.drain({ maxJobs: 5, stage: "reconcile" });
      await answered.reached;

      expect(await postDeliveryEvent(await webhook.webhook(), { type: "email.delivered", providerMessageId })).toBe(200);
      expect(await webhook.worker.drain({ maxJobs: 5, stage: "inbound" })).toMatchObject({ processed: 1 });
      const delivered = await sendIntentOf(database, messageId);
      expect(delivered).toMatchObject({ state: "delivered", version: intent.version + 1 });
      answered.release();

      expect(await reconciling).toMatchObject({ reconciled: 1 });
      expect(await sendIntentOf(database, messageId)).toEqual(delivered);
      expect(counterValue(reconciler.metrics, CONFLICTS, { writer: "reconciler" })).toBe(1);
      expect(await deliveryFailuresOf(database, conversationId)).toEqual([]);
      expect(reconciler.logger.messages()).not.toContain("email_send_uncertain");
    },
  );

  it("never halts a send another claim froze after a stale claim read it: the claim that froze it sends it once", async () => {
    const { conversationId, messageId, domain } = await queuedReply();
    const key = emailSendKey.message(messageId);
    const setSendingStatus = (status: string) =>
      database.execute("UPDATE email_domains SET sending_status = $2 WHERE id = $1", [domain.id, status]);
    const [stale, current] = [workerNode(), workerNode()];
    // Claim A finds the domain unverified and stalls before its halt lands.
    await setSendingStatus("failed");
    const halting = stale.seams.pauseAt("writer.apply", "before");
    const staleDispatch = stale.dispatch();
    await halting.reached;

    // The domain verifies again; A's lease runs out, and claim B freezes the request and enters the provider call.
    await setSendingStatus("verified");
    await expireOutboxClaims(database, conversationId);
    const posting = current.seams.pauseAt("driver.send", "before");
    const currentDispatch = current.dispatch();
    await posting.reached;

    halting.release();
    expect(await staleDispatch).toMatchObject({ dispatched: 0, retried: 0, failed: 0 });
    const frozen = await sendIntentOf(database, messageId);
    expect(frozen).toMatchObject({ state: "queued", haltReason: null, providerMessageId: null });
    expect(frozen.request).not.toBeNull();
    expect(await deliveryFailuresOf(database, conversationId)).toEqual([]);
    expect(counterValue(stale.metrics, CONFLICTS, { writer: "handler" })).toBe(1);
    expect(stale.logger.messages()).toContain("email_send_left_to_freezing_claim");

    posting.release();
    expect(await currentDispatch).toMatchObject({ dispatched: 1, failed: 0 });
    const [accepted, ...others] = await providerAcceptsUnder(spool.dir, key);
    expect(others).toEqual([]);
    expect(await sendIntentOf(database, messageId)).toMatchObject({ state: "accepted", haltReason: null, providerMessageId: accepted?.providerMessageId });
    expect(stale.provider.sendKeys).toEqual([]);
    expect(current.provider.sendKeys).toEqual([key]);
    expect(await deliveryFailuresOf(database, conversationId)).toEqual([]);
    expect(await outboxActionsOf(database, conversationId)).toEqual([expect.objectContaining({ status: "dispatched", attempts: 2 })]);
  });

  /** Waits until `count` sessions of the suite's database wait on a row lock; the statements waiting. */
  const lockWaiters = async (count: number): Promise<string[]> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await database.query<{ query: string }>(
        "SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (waiting.length >= count) return waiting.map((row) => row.query);
      if (Date.now() > deadline) throw new Error(`expected ${count} lock waiter(s), saw ${waiting.length}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it.each([
    ["its domain stopped being verified", "UPDATE email_domains SET sending_status = 'failed' WHERE id = $1", "sending_not_verified"],
    ["its domain was removed", "UPDATE email_domains SET removed_at = now() WHERE id = $1", "domain_removed"],
  ] as const)("halts an operator reply once %s after its claim loaded it and before its freeze (FR-025)", async (_label, revocation, haltReason) => {
    const { conversationId, messageId, domain } = await queuedReply();
    const sender = workerNode();
    const paused = sender.seams.pauseAt("sendCommitment.commit", "before");
    const dispatching = sender.dispatch();
    await paused.reached;

    await database.execute(revocation, [domain.id]);
    paused.release();

    expect(await dispatching).toMatchObject({ dispatched: 1, failed: 0 });
    expect(await sendIntentOf(database, messageId)).toMatchObject({ state: "halted", haltReason, request: null, providerMessageId: null });
    expect(sender.provider.sendKeys).toEqual([]);
    expect((await deliveryFailuresOf(database, conversationId)).map((failure) => [failure.message_id, failure.failure_kind])).toEqual([
      [messageId, "halted"],
    ]);
  });

  it("makes a readiness downgrade that arrives inside an operator reply's commitment wait on the domain for its freeze: the reply goes out once", async () => {
    const { messageId, domain } = await queuedReply();
    const key = emailSendKey.message(messageId);
    const sender = workerNode();
    const paused = sender.seams.pauseAt("commitment.freezeRequest", "before");
    const dispatching = sender.dispatch();
    await paused.reached;

    const downgrading = database.execute("UPDATE email_domains SET sending_status = 'failed' WHERE id = $1", [domain.id]);
    // The commitment holds the domain row `FOR SHARE`: the downgrade cannot commit before the freeze.
    expect(await lockWaiters(1)).toEqual([expect.stringMatching(/^UPDATE email_domains/u)]);
    paused.release();

    expect(await dispatching).toMatchObject({ dispatched: 1, failed: 0 });
    await downgrading;
    expect(await sendIntentOf(database, messageId)).toMatchObject({ state: "accepted", haltReason: null });
    expect(await providerAcceptsUnder(spool.dir, key)).toHaveLength(1);
  });

  it("records a stalled claim's acceptance after the last attempt lost the freeze to it and gave the send up as uncertain (FR-036)", async () => {
    const { conversationId, messageId } = await queuedReply();
    const key = emailSendKey.message(messageId);
    // The action is on its last two of five attempts.
    await database.execute("UPDATE routine_action_requests SET attempts = 3 WHERE conversation_id = $1", [conversationId]);
    const [stalled, last] = [workerNode(), workerNode()];
    // Attempt 4 reads the intent unfrozen and stalls before its commitment.
    const stalledCommit = stalled.seams.pauseAt("sendCommitment.commit", "before");
    const stalledPost = stalled.seams.pauseAt("driver.send", "before");
    const stalledDispatch = stalled.dispatch();
    await stalledCommit.reached;
    // Its lease runs out; attempt 5 reads the intent unfrozen too, and stalls likewise.
    await expireOutboxClaims(database, conversationId);
    const lastCommit = last.seams.pauseAt("sendCommitment.commit", "before");
    const lastDispatch = last.dispatch();
    await lastCommit.reached;

    // Attempt 4 freezes the request and enters the provider call; attempt 5 loses the freeze to it,
    // and its failure, the action's last, gives the send up as uncertain.
    stalledCommit.release();
    await stalledPost.reached;
    lastCommit.release();
    expect(await lastDispatch).toMatchObject({ dispatched: 0, failed: 1 });
    expect(await sendIntentOf(database, messageId)).toMatchObject({ state: "uncertain", outcomeUnknown: true, providerMessageId: null });

    // Attempt 4's provider call comes back accepted.
    stalledPost.release();
    await stalledDispatch;
    const [accept, ...others] = await providerAcceptsUnder(spool.dir, key);
    expect(others).toEqual([]);
    const intent = await sendIntentOf(database, messageId);
    expect(intent).toMatchObject({
      state: "uncertain",
      providerMessageId: accept.providerMessageId,
      uncertainResolution: null,
      acceptedAt: expect.any(Date),
      nextReconcileAt: expect.any(Date),
    });
    expect(await indexedMessageIdsOf(database, conversationId)).toContain(intent.suppliedRfcMessageId);
    expect(stalled.logger.messages()).toContain("email_send_late_acceptance");
    // The doubt is a teammate's until evidence settles it.
    expect((await deliveryFailuresOf(database, conversationId)).map((failure) => [failure.failure_kind, failure.clear_reason])).toEqual([
      ["uncertain", null],
    ]);

    // Its delivery now correlates by the provider's id, and settles it without any resend.
    const webhook = workerNode();
    expect(await postDeliveryEvent(await webhook.webhook(), { type: "email.delivered", providerMessageId: accept.providerMessageId })).toBe(200);
    expect(await webhook.worker.drain({ maxJobs: 5, stage: "inbound" })).toMatchObject({ processed: 1 });
    expect(await sendIntentOf(database, messageId)).toMatchObject({ state: "delivered", uncertainResolution: "provider_evidence" });
    expect((await deliveryFailuresOf(database, conversationId)).map((failure) => [failure.failure_kind, failure.clear_reason])).toEqual([
      ["uncertain", "provider_evidence"],
    ]);
    expect(await providerAcceptsUnder(spool.dir, key)).toHaveLength(1);
  });

  it("makes an unknown outcome uncertain without a re-POST once the sending authority is revoked", async () => {
    const { conversationId, messageId, domain, workspaceId } = await queuedReply();
    const key = emailSendKey.message(messageId);
    const sender = workerNode();
    // The provider accepts the message and the answer is lost on the way back.
    sender.provider.loseNextResponse();

    expect(await sender.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

    const unknown = await sendIntentOf(database, messageId);
    expect(unknown).toMatchObject({ state: "queued", outcomeUnknown: true, providerMessageId: null, nextReconcileAt: expect.any(Date) });
    expect(sender.drains.requests).toEqual([{ maxJobs: 5, stage: "reconcile", scheduleAt: unknown.nextReconcileAt }]);
    expect(await providerAcceptsUnder(spool.dir, key)).toHaveLength(1);

    await database.execute("UPDATE email_domains SET sending_status = 'failed' WHERE id = $1", [domain.id]);
    await makeReconcileDue(database, unknown.id);
    const reconciler = workerNode();
    expect(await reconciler.worker.drain({ maxJobs: 5, stage: "reconcile" })).toMatchObject({ reconciled: 1 });

    expect(reconciler.provider.sendKeys).toEqual([]);
    const uncertain = await sendIntentOf(database, messageId);
    expect(uncertain).toMatchObject({ state: "uncertain", outcomeUnknown: true, providerMessageId: null, nextReconcileAt: null });
    expect((await deliveryFailuresOf(database, conversationId)).map((failure) => [failure.message_id, failure.failure_kind])).toEqual([
      [messageId, "uncertain"],
    ]);
    const facts = await api.channel.conversationFacts.read(workspaceId, conversationId);
    expect(facts?.messages.find((message) => message.messageId === messageId)?.delivery).toMatchObject({ state: "uncertain" });

    // Neither a redelivered action nor a later sweep sends it again: only an operator may.
    await database.execute("UPDATE routine_action_requests SET status = 'pending' WHERE conversation_id = $1", [conversationId]);
    const redelivered = workerNode();
    expect(await redelivered.dispatch()).toMatchObject({ dispatched: 1 });
    expect(await redelivered.worker.sweep({ maxJobs: 5 })).toMatchObject({ reconciledSends: 0 });
    expect(redelivered.provider.sendKeys).toEqual([]);
    expect(await sendIntentOf(database, messageId)).toEqual(uncertain);
    expect(await providerAcceptsUnder(spool.dir, key)).toHaveLength(1);
    expect((await outboxActionsOf(database, conversationId)).map((action) => action.idempotency_key)).toEqual([key]);
  });

  it("re-POSTs an unknown outcome under the same key while the sending authority holds, and the provider accepts it once", async () => {
    const { messageId } = await queuedReply();
    const key = emailSendKey.message(messageId);
    const sender = workerNode();
    sender.provider.loseNextResponse();
    expect(await sender.dispatch()).toMatchObject({ dispatched: 1 });
    const unknown = await sendIntentOf(database, messageId);

    await makeReconcileDue(database, unknown.id);
    const reconciler = workerNode();
    expect(await reconciler.worker.drain({ maxJobs: 5, stage: "reconcile" })).toMatchObject({ reconciled: 1 });

    expect(reconciler.provider.sendKeys).toEqual([key]);
    const [accepted, ...others] = await providerAcceptsUnder(spool.dir, key);
    expect(others).toEqual([]);
    expect(await sendIntentOf(database, messageId)).toMatchObject({
      state: "accepted",
      outcomeUnknown: true,
      providerMessageId: accepted?.providerMessageId,
      request: unknown.request,
    });
  });
});
