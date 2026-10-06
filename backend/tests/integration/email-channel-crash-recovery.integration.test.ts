import type { ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { EMAIL_SEND_ACTION_TYPE, emailSendKey } from "../../src/modules/emailChannel/public.js";
import type { Database } from "../../src/shared/infra/database.js";
import {
  activityOf,
  conversationsOfMailbox,
  createEmailChannelDatabase,
  createSpool,
  createWorkerNode,
  customerMessagesOf,
  deliveriesOfEmail,
  deliveryOfEmail,
  eventOfEmail,
  expireLease,
  indexedMessageIdsOf,
  ownershipOf,
  postReceived,
  providerRewrittenMessageId,
  readFixture,
  relayAddressOf,
  seedMailbox,
  seedSupportMailbox,
  threadLinksOf,
  type SeededMailbox,
  type Seam,
} from "./support/emailChannelHarness.js";
import {
  createApiNode,
  expireOutboxClaims,
  messagesOf,
  openEmailConversation,
  outboxActionsOf,
  providerAcceptsUnder,
  replyFromInbox,
  sendIntentOf,
  sendIntentsOf,
} from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// SC-007: a worker killed at each stage boundary, then recovered once its lease runs out, records
// exactly one message per inbound delivery and splits no thread — even when the follow-up is
// processed by another worker while the first lies dead — and makes at most one provider accept
// per outbound send intent. An automatic reply killed after it is queued, inside its
// materialization, or after the provider accepted it is written as one message and accepted once.
// The kill is a fault hook on the worker's own dependencies: after it fires, the dead worker makes
// no further call, so nothing is retried or settled on its behalf; one inside a transaction rolls
// it back, as a dead connection does.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const FIRST = "mime/first-contact.eml";
const FOLLOW_UP = "mime/pre-reply-follow-up.eml";

type WorkerNode = ReturnType<typeof createWorkerNode>;

interface Boundary {
  name: string;
  crash: { seam: Seam; when: "before" | "after"; nth?: number };
  /** The dead worker's delivery, as the crash left it; null when none was written yet. */
  leftAs: string | null;
}

const BOUNDARIES: readonly Boundary[] = [
  { name: "the event is persisted", crash: { seam: "receiver.fetchMessage", when: "before" }, leftAs: null },
  { name: "the content is fetched", crash: { seam: "inbound.recordFetched", when: "after" }, leftAs: "fetched" },
  { name: "the thread is resolved and reserved", crash: { seam: "threadProtocol.run", when: "after", nth: 1 }, leftAs: "resolved" },
  { name: "host ingest commits, before the delivery records it", crash: { seam: "chat.ingest", when: "after" }, leftAs: "resolved" },
  { name: "the delivery records its ingest", crash: { seam: "inbound.recordIngested", when: "after" }, leftAs: "ingested" },
  { name: "the thread is indexed", crash: { seam: "threadProtocol.run", when: "after", nth: 2 }, leftAs: "done" },
];

describeIntegration("email channel crash recovery (Postgres, SC-007)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Awaited<ReturnType<typeof createSpool>>;
  const nodes: WorkerNode[] = [];

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "crash_recovery");
    database = suite.database;
    spool = await createSpool();
  }, 60_000);

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((node) => node.close().catch(() => undefined)));
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

  const receive = async (
    via: WorkerNode,
    fixture: string,
    target: { mailbox: SeededMailbox; domain: string },
    receivedFor: readonly string[] = [relayAddressOf(target.mailbox)],
  ): Promise<string> => {
    const emailId = await spool.put(await readFixture(fixture, { relayToken: target.mailbox.relayToken, domain: target.domain }));
    expect(await postReceived(await via.webhook(), { emailId, receivedFor })).toBe(200);
    return emailId;
  };

  const drainOne = (node: WorkerNode) => node.worker.drain({ maxJobs: 1, stage: "inbound" });

  /** The dead worker's claim stays leased; it is recovered only once the lease runs out. */
  const recoverAfterLease = async (node: WorkerNode, emailId: string) => {
    const event = await eventOfEmail(database, emailId);
    expect(event).toMatchObject({ state: "processing", attempts: 1 });
    expect(await node.worker.sweep({ maxJobs: 5 })).toMatchObject({ recoveredLeases: 0, drained: 0 });
    await expireLease(database, event.id);
    expect(await node.worker.sweep({ maxJobs: 5 })).toMatchObject({ recoveredLeases: 1, drained: 1 });
    expect(await eventOfEmail(database, emailId)).toMatchObject({ state: "processed", attempts: 2, last_error_code: null });
  };

  /** Each delivery done with its own message, exactly once, all in one conversation. */
  const expectOneMessagePerDelivery = async (mailbox: SeededMailbox, emailIds: readonly string[]) => {
    const conversations = await conversationsOfMailbox(database, mailbox);
    expect(conversations).toHaveLength(1);
    const [conversationId] = conversations;
    const deliveries = await Promise.all(emailIds.map((emailId) => deliveryOfEmail(database, emailId)));
    for (const delivery of deliveries) {
      expect(delivery).toMatchObject({ state: "done", conversation_id: conversationId, message_id: delivery.planned_message_id });
    }
    const messages = await customerMessagesOf(database, conversationId);
    expect(messages.map((message) => message.id).sort()).toEqual(deliveries.map((delivery) => delivery.message_id).sort());
    expect(messages.every((message) => message.role === "user" && message.source === "customer")).toBe(true);
    expect((await threadLinksOf(database, mailbox)).map((link) => link.conversation_id)).toEqual([conversationId]);
    expect((await activityOf(database, conversationId)).map((entry) => entry.kind)).toEqual(["handoff_requested"]);
    expect(await ownershipOf(database, conversationId)).toMatchObject({ state: "human_owned", reason: "operator_only_mailbox" });
    return { conversationId, deliveries };
  };

  it.each(BOUNDARIES)("kills the worker after $name and recovers to one message per delivery, one thread", async (boundary) => {
    const { mailbox, domain } = await seedSupportMailbox(database);
    const target = { mailbox, domain: domain.domain };
    const [doomed, survivor] = [workerNode(), workerNode()];
    doomed.seams.crashAt(boundary.crash);

    const firstEmail = await receive(doomed, FIRST, target);
    expect(await drainOne(doomed)).toMatchObject({ claimed: 1, errored: 1 });
    expect(doomed.seams.hasCrashed).toBe(true);
    expect(doomed.logger.messages()).toContain("email_inbound_event_errored");
    const left = await deliveriesOfEmail(database, firstEmail);
    expect(left.map((delivery) => delivery.state)).toEqual(boundary.leftAs === null ? [] : [boundary.leftAs]);

    // The customer's follow-up arrives, and another worker handles it, while the first is dead.
    const followUpEmail = await receive(survivor, FOLLOW_UP, target);
    expect(await drainOne(survivor)).toMatchObject({ claimed: 1, processed: 1 });

    await recoverAfterLease(survivor, firstEmail);
    const { conversationId } = await expectOneMessagePerDelivery(mailbox, [firstEmail, followUpEmail]);
    expect(await indexedMessageIdsOf(database, conversationId)).toEqual(["<msg-0001@example.test>", "<msg-0002@example.test>"]);
  });

  it("keeps a dead worker's reservation through retention, so the retry after long downtime ingests once", async () => {
    const { mailbox, domain } = await seedSupportMailbox(database);
    const [doomed, survivor] = [workerNode(), workerNode()];
    // The host's ingest commits; the worker dies before the delivery records it.
    doomed.seams.crashAt({ seam: "chat.ingest", when: "after" });
    const emailId = await receive(doomed, FIRST, { mailbox, domain: domain.domain });
    expect(await drainOne(doomed)).toMatchObject({ errored: 1 });
    const reserved = await deliveryOfEmail(database, emailId);
    expect(reserved).toMatchObject({ state: "resolved", conversation_id: null });

    // The outage outlasts the 30-day retention window before anything recovers the claim.
    const event = await eventOfEmail(database, emailId);
    await database.execute("UPDATE email_inbound_deliveries SET created_at = now() - interval '40 days' WHERE id = $1", [reserved.id]);
    await database.execute("UPDATE email_inbound_events SET received_at = now() - interval '40 days' WHERE id = $1", [event.id]);
    await expireLease(database, event.id);
    expect(await survivor.worker.sweep({ maxJobs: 5 })).toMatchObject({ recoveredLeases: 1, purgedDeliveries: 0, drained: 1 });

    const [conversationId, ...others] = await conversationsOfMailbox(database, mailbox);
    expect(others).toEqual([]);
    expect(conversationId).toBe(reserved.planned_conversation_id);
    expect(await deliveryOfEmail(database, emailId)).toMatchObject({ id: reserved.id, state: "done", message_id: reserved.planned_message_id });
    expect(await customerMessagesOf(database, conversationId)).toHaveLength(1);
  });

  it("resumes a two-mailbox event killed between its deliveries without repeating the finished one", async () => {
    const { workspaceId, mailbox: support, domain } = await seedSupportMailbox(database);
    const sales = await seedMailbox(database, { workspaceId, domain, local: "sales" });
    const [doomed, survivor] = [workerNode(), workerNode()];
    // The second protocol transaction indexes the first mailbox's delivery.
    doomed.seams.crashAt({ seam: "threadProtocol.run", when: "after", nth: 2 });

    const emailId = await receive(doomed, "mime/two-mailbox.eml", { mailbox: support, domain: domain.domain }, [
      relayAddressOf(support),
      relayAddressOf(sales),
    ]);
    expect(await drainOne(doomed)).toMatchObject({ errored: 1 });
    expect((await deliveriesOfEmail(database, emailId)).map((delivery) => [delivery.mailbox_id, delivery.state])).toEqual([
      [support.id, "done"],
    ]);

    await recoverAfterLease(survivor, emailId);
    const deliveries = await deliveriesOfEmail(database, emailId);
    expect(deliveries.map((delivery) => [delivery.mailbox_id, delivery.state])).toEqual([
      [support.id, "done"],
      [sales.id, "done"],
    ]);
    for (const mailbox of [support, sales]) {
      const [conversationId, ...others] = await conversationsOfMailbox(database, mailbox);
      expect(others).toEqual([]);
      const delivery = deliveries.find((candidate) => candidate.mailbox_id === mailbox.id);
      expect((await customerMessagesOf(database, conversationId)).map((message) => message.id)).toEqual([delivery?.message_id]);
    }
  });

  describe("sending: at most one provider accept per send intent", () => {
    interface SendBoundary {
      name: string;
      crash: { seam: Seam; when: "before" | "after" };
      /** A provider that reports the delivered Message-ID only on lookup, so step 6 has work to do. */
      rewritesMessageId: boolean;
      /** The send intent as the crash left it; null when none was written yet. */
      leftAs: { state: string; provider: "accepted" | "not_called"; recorded: boolean } | null;
      /** Provider calls the survivor makes: the re-POST under the same key, or none at all. */
      survivorSends: number;
    }

    const SEND_BOUNDARIES: readonly SendBoundary[] = [
      {
        name: "the outbox claim",
        crash: { seam: "outbox.claimPending", when: "after" },
        rewritesMessageId: false,
        leftAs: null,
        survivorSends: 1,
      },
      {
        name: "the provider accepted, before the acceptance is recorded",
        crash: { seam: "driver.send", when: "after" },
        rewritesMessageId: false,
        leftAs: { state: "queued", provider: "accepted", recorded: false },
        survivorSends: 1,
      },
      {
        name: "the acceptance is recorded, before the delivered Message-ID is fetched",
        crash: { seam: "driver.lookup", when: "before" },
        rewritesMessageId: true,
        leftAs: { state: "accepted", provider: "accepted", recorded: true },
        survivorSends: 0,
      },
    ];

    let api: ReturnType<typeof createApiNode>;

    beforeAll(() => {
      api = createApiNode(database, { spoolDir: spool.dir });
    });

    it.each(SEND_BOUNDARIES)("kills the sender after $name and recovers to one provider accept", async (boundary) => {
      const conversation = await openEmailConversation(database, { node: workerNode(), spool });
      const { conversationId, domain } = conversation;
      const messageId = await replyFromInbox(database, api, conversation);
      const key = emailSendKey.message(messageId);
      const acceptsUnderKey = () => providerAcceptsUnder(spool.dir, key);
      const sender = (): WorkerNode => {
        const node = createWorkerNode(suite.url, { spoolDir: spool.dir, rewritesMessageId: boundary.rewritesMessageId });
        nodes.push(node);
        return node;
      };
      const [doomed, survivor] = [sender(), sender()];
      doomed.seams.crashAt(boundary.crash);

      await expect(doomed.dispatch()).rejects.toThrow("worker crashed");
      expect(doomed.seams.hasCrashed).toBe(true);
      expect(await outboxActionsOf(database, conversationId)).toEqual([expect.objectContaining({ status: "in_progress", attempts: 1 })]);
      if (boundary.leftAs === null) {
        expect(await sendIntentsOf(database, messageId)).toEqual([]);
        expect(await acceptsUnderKey()).toEqual([]);
      } else {
        const left = await sendIntentOf(database, messageId);
        expect(left).toMatchObject({ state: boundary.leftAs.state, outcomeUnknown: false, deliveredRfcMessageId: null });
        expect(left.request).not.toBeNull();
        expect(left.providerMessageId !== null).toBe(boundary.leftAs.recorded);
        expect(await acceptsUnderKey()).toHaveLength(1);
      }

      // The survivor reclaims the action only once the dead worker's claim runs out.
      expect(await survivor.dispatch()).toMatchObject({ dispatched: 0 });
      await expireOutboxClaims(database, conversationId);
      expect(await survivor.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

      const [accepted, ...otherAccepts] = await acceptsUnderKey();
      expect(otherAccepts).toEqual([]);
      expect(survivor.provider.sendKeys).toEqual(Array.from({ length: boundary.survivorSends }, () => key));
      expect(await outboxActionsOf(database, conversationId)).toEqual([expect.objectContaining({ status: "dispatched", attempts: 2 })]);
      const intent = await sendIntentOf(database, messageId);
      const supplied = `<${intent.id}@${domain.domain}>`;
      const delivered = boundary.rewritesMessageId ? providerRewrittenMessageId(accepted?.providerMessageId ?? "") : supplied;
      expect(intent).toMatchObject({
        state: "accepted",
        outcomeUnknown: false,
        providerMessageId: accepted?.providerMessageId,
        suppliedRfcMessageId: supplied,
        deliveredRfcMessageId: delivered,
      });
      // The customer's reply to either id threads back to this conversation.
      expect(await database.query<{ rfc_message_id: string }>(
        "SELECT rfc_message_id FROM email_thread_messages WHERE message_id = $1 ORDER BY origin DESC",
        [messageId],
      )).toEqual([...new Set([supplied, delivered])].map((rfcMessageId) => ({ rfc_message_id: rfcMessageId })));
    });
  });

  describe("automatic replies: at most one message and one provider accept (research B9)", () => {
    const AUTO = ["operator_only", "draft", "auto"] as const;
    const ANSWER = "Hi Alice, you can update your billing address under Settings > Billing.";
    /** The conversation of every review turn the host ran. */
    const reviewed: string[] = [];

    const answering = async (input: ConnectorRespondInput): Promise<ConnectorTurnResult> => {
      reviewed.push(input.conversationId);
      return {
        kind: "draft",
        conversationId: input.conversationId,
        ownershipVersion: 0,
        facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false }, suppressedEffects: [], citationCount: 1 },
        draft: { text: ANSWER, presentation: { citations: [] } },
      };
    };

    const autoNode = (): WorkerNode => {
      const node = createWorkerNode(suite.url, { spoolDir: spool.dir, supportedModes: AUTO, respond: answering });
      nodes.push(node);
      return node;
    };

    const heldRepliesOf = (conversationId: string) =>
      database.query<{ id: string; state: string; release_kind: string | null; released_message_id: string | null }>(
        "SELECT id, state, release_kind, released_message_id FROM held_replies WHERE conversation_id = $1 ORDER BY created_at, id",
        [conversationId],
      );

    const agentMessagesOf = async (conversationId: string) =>
      (await messagesOf(database, conversationId)).filter((message) => message.role === "assistant");

    const emailSendsOf = async (conversationId: string) =>
      (await outboxActionsOf(database, conversationId)).filter((action) => action.type === EMAIL_SEND_ACTION_TYPE);

    const reviewLinkOf = (conversationId: string) =>
      database.queryOne<{ review_revision: number; review_completed_revision: number; review_due_at: Date | null; lease_live: boolean }>(
        `SELECT review_revision, review_completed_revision, review_due_at, COALESCE(review_lease_until > now(), false) AS lease_live
           FROM email_thread_links WHERE conversation_id = $1`,
        [conversationId],
      );

    /** Brings the thread's review due and drains it through `node`. */
    const drainReview = async (node: WorkerNode, conversationId: string) => {
      await database.execute(
        "UPDATE email_thread_links SET review_due_at = now() - interval '1 second' WHERE conversation_id = $1 AND review_due_at IS NOT NULL",
        [conversationId],
      );
      return node.worker.drain({ maxJobs: 5, stage: "review" });
    };

    /** Alice's first contact on an `auto` mailbox, reviewed through `reviewer` and queued: its send not yet dispatched. */
    const queuedAutoReply = async (reviewer: WorkerNode) => {
      const { conversationId } = await openEmailConversation(database, { node: reviewer, spool }, { engagementMode: "auto", withAgent: true });
      expect(await drainReview(reviewer, conversationId)).toMatchObject({ reviewed: 1 });
      const [held, ...others] = await heldRepliesOf(conversationId);
      expect(others).toEqual([]);
      expect(held).toMatchObject({ state: "queued_auto" });
      return { conversationId, heldReplyId: held.id, key: emailSendKey.heldReply(held.id) };
    };

    /** One agent message, released from the held reply as automatic and accepted once under its key. */
    const expectSentOnce = async (sent: { conversationId: string; heldReplyId: string; key: string }) => {
      const [message, ...otherMessages] = await agentMessagesOf(sent.conversationId);
      expect(otherMessages).toEqual([]);
      expect(message).toMatchObject({ content: ANSWER });
      expect(await heldRepliesOf(sent.conversationId)).toEqual([
        { id: sent.heldReplyId, state: "released", release_kind: "auto", released_message_id: message.id },
      ]);
      expect(await sendIntentOf(database, message.id)).toMatchObject({ idempotencyKey: sent.key, trigger: "auto_reply", state: "accepted" });
      expect(await providerAcceptsUnder(spool.dir, sent.key)).toHaveLength(1);
      return message;
    };

    it("kills the reviewer after queueAuto commits, before the drain, and sends the reply once without a second turn", async () => {
      const [doomed, survivor] = [autoNode(), autoNode()];
      doomed.seams.crashAt({ seam: "heldReplies.queueAuto", when: "after" });
      const { conversationId } = await openEmailConversation(database, { node: doomed, spool }, { engagementMode: "auto", withAgent: true });

      expect(await drainReview(doomed, conversationId)).toMatchObject({ reviewed: 1 });
      expect(doomed.seams.hasCrashed).toBe(true);
      // The reply and its send are queued; the review is still the dead worker's, leased and incomplete.
      const [held] = await heldRepliesOf(conversationId);
      expect(held).toMatchObject({ state: "queued_auto" });
      const key = emailSendKey.heldReply(held.id);
      expect(await emailSendsOf(conversationId)).toEqual([expect.objectContaining({ idempotency_key: key, status: "pending", attempts: 0 })]);
      expect(await agentMessagesOf(conversationId)).toEqual([]);
      const left = await reviewLinkOf(conversationId);
      expect(left).toMatchObject({ lease_live: true });
      expect(left.review_completed_revision).toBeLessThan(left.review_revision);

      expect(await survivor.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });
      await expectSentOnce({ conversationId, heldReplyId: held.id, key });

      // Once the dead worker's claim runs out the review completes from its queued reply, without a second turn.
      expect(await survivor.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 0 });
      await database.execute("UPDATE email_thread_links SET review_lease_until = now() - interval '1 second' WHERE conversation_id = $1", [conversationId]);
      expect(await survivor.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });
      expect(reviewed.filter((id) => id === conversationId)).toHaveLength(1);
      const completed = await reviewLinkOf(conversationId);
      expect(completed).toMatchObject({ review_completed_revision: completed.review_revision, review_due_at: null, lease_live: false });
      expect(await survivor.dispatch()).toMatchObject({ dispatched: 0 });
      await expectSentOnce({ conversationId, heldReplyId: held.id, key });
      expect(survivor.provider.sendKeys).toEqual([key]);
    });

    interface AutoSendBoundary {
      name: string;
      crash: { seam: Seam; when: "before" | "after" };
      /** What the crash left: the held reply's state, the message and its intent, and the provider's accepts. */
      leftAs: { held: "queued_auto" | "released"; message: boolean; frozen: boolean; accepts: number };
    }

    const AUTO_SEND_BOUNDARIES: readonly AutoSendBoundary[] = [
      {
        name: "inside the materialization, after its message is written",
        crash: { seam: "heldReplyChannel.recordMaterialized", when: "before" },
        leftAs: { held: "queued_auto", message: false, frozen: false, accepts: 0 },
      },
      {
        name: "after the materialization commits, before the send",
        crash: { seam: "heldReplies.materializeAuto", when: "after" },
        leftAs: { held: "released", message: true, frozen: false, accepts: 0 },
      },
      {
        name: "after the provider accepted, before the acceptance is recorded",
        crash: { seam: "driver.send", when: "after" },
        leftAs: { held: "released", message: true, frozen: true, accepts: 1 },
      },
    ];

    it.each(AUTO_SEND_BOUNDARIES)("kills the sender $name and recovers to one message and one provider accept", async (boundary) => {
      const queued = await queuedAutoReply(autoNode());
      const { conversationId, key } = queued;
      const [doomed, survivor] = [autoNode(), autoNode()];
      doomed.seams.crashAt(boundary.crash);

      await expect(doomed.dispatch()).rejects.toThrow("worker crashed");
      expect(doomed.seams.hasCrashed).toBe(true);
      expect(await emailSendsOf(conversationId)).toEqual([expect.objectContaining({ status: "in_progress", attempts: 1 })]);
      expect((await heldRepliesOf(conversationId)).map((held) => held.state)).toEqual([boundary.leftAs.held]);
      const leftMessages = await agentMessagesOf(conversationId);
      expect(leftMessages).toHaveLength(boundary.leftAs.message ? 1 : 0);
      if (boundary.leftAs.message) {
        const left = await sendIntentOf(database, leftMessages[0].id);
        expect(left).toMatchObject({ state: "queued", outcomeUnknown: false, providerMessageId: null });
        expect(left.request !== null).toBe(boundary.leftAs.frozen);
      } else {
        expect(await database.query("SELECT id FROM email_send_intents WHERE conversation_id = $1", [conversationId])).toEqual([]);
      }
      expect(await providerAcceptsUnder(spool.dir, key)).toHaveLength(boundary.leftAs.accepts);

      // The survivor reclaims the action only once the dead worker's claim runs out.
      expect(await survivor.dispatch()).toMatchObject({ dispatched: 0 });
      await expireOutboxClaims(database, conversationId);
      expect(await survivor.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

      const sent = await expectSentOnce(queued);
      if (boundary.leftAs.message) expect(sent.id).toBe(leftMessages[0].id);
      // One provider call: the first send, or the re-POST under the same key the provider answers once.
      expect(survivor.provider.sendKeys).toEqual([key]);
      expect(await emailSendsOf(conversationId)).toEqual([expect.objectContaining({ status: "dispatched", attempts: 2 })]);
    });
  });
});
