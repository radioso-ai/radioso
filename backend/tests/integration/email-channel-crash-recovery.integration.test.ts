import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { emailSendKey } from "../../src/modules/emailChannel/public.js";
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
// per outbound send intent. The kill is a fault hook on the worker's own dependencies: after it
// fires, the dead worker makes no further call, so nothing is retried or settled on its behalf.

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
});
