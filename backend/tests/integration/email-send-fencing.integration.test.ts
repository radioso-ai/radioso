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
  postDeliveryEvent,
} from "./support/emailChannelHarness.js";
import {
  counterValue,
  createApiNode,
  deliveryFailuresOf,
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
