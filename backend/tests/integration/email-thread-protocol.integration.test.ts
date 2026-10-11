import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import type { Database } from "../../src/shared/infra/database.js";
import {
  barrier,
  conversationsOfMailbox,
  createEmailChannelDatabase,
  createSpool,
  createWorkerNode,
  customerMessagesOf,
  deliveryOfEmail,
  deliveriesOfEmail,
  eventOfEmail,
  expireLease,
  indexedMessageIdsOf,
  postReceived,
  readFixture,
  relayAddressOf,
  seedMailbox,
  seedSupportMailbox,
  threadLinksOf,
  type SeededMailbox,
} from "./support/emailChannelHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Research B15's durable thread protocol against Postgres, with two worker processes (each its own
// pool) racing over the out-of-order pair: the follow-up `msg-0011` names the parent `msg-0010` in
// In-Reply-To and References. Whatever the interleaving — reservation in flight, reverse match,
// crash between steps, a shared new thread, a late parent — one thread per mailbox results.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const PARENT = "mime/out-of-order-parent.eml";
const CHILD = "mime/out-of-order-child.eml";
const PARENT_ID = "<msg-0010@example.test>";
const CHILD_ID = "<msg-0011@example.test>";

type WorkerNode = ReturnType<typeof createWorkerNode>;
type Spool = Awaited<ReturnType<typeof createSpool>>;

describeIntegration("email thread protocol interleavings (Postgres, research B15)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Spool;
  const nodes: WorkerNode[] = [];

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "thread_protocol");
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

  /** Spools `fixture` addressed to `mailbox` and has the provider post it; returns the email id. */
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

  /** A dead worker's claim: its lease runs out, the sweep recovers it, and `node` drains it. */
  const recoverWith = async (node: WorkerNode, emailId: string) => {
    await expireLease(database, (await eventOfEmail(database, emailId)).id);
    return node.worker.sweep({ maxJobs: 5 });
  };

  /** One conversation holding both messages, linked once, with both Message-Ids indexed to it. */
  const expectOneThread = async (mailbox: SeededMailbox, emailIds: readonly string[]) => {
    const conversations = await conversationsOfMailbox(database, mailbox);
    expect(conversations).toHaveLength(1);
    const [conversationId] = conversations;
    const deliveries = await Promise.all(emailIds.map((emailId) => deliveryOfEmail(database, emailId)));
    expect(deliveries.map((delivery) => [delivery.state, delivery.conversation_id])).toEqual(
      emailIds.map(() => ["done", conversationId]),
    );
    const messages = await customerMessagesOf(database, conversationId);
    expect(messages.map((message) => message.id).sort()).toEqual(deliveries.map((delivery) => delivery.message_id).sort());
    expect((await threadLinksOf(database, mailbox)).map((link) => link.conversation_id)).toEqual([conversationId]);
    expect(await indexedMessageIdsOf(database, conversationId)).toEqual(expect.arrayContaining([PARENT_ID, CHILD_ID]));
    return { conversationId, deliveries };
  };

  it("(i) joins a follow-up to its parent's reservation while the parent is resolved but not ingested", async () => {
    const { mailbox, domain } = await seedSupportMailbox(database);
    const target = { mailbox, domain: domain.domain };
    const [a, b] = [workerNode(), workerNode()];
    const parentHeld = a.seams.pauseAt("chat.ingest", "before");

    const parentEmail = await receive(a, PARENT, target);
    const parentRun = drainOne(a);
    await parentHeld.reached;
    const reserved = await deliveryOfEmail(database, parentEmail);
    expect(reserved).toMatchObject({ state: "resolved", thread_match: "new_thread", conversation_id: null });

    const childEmail = await receive(b, CHILD, target);
    expect(await drainOne(b)).toMatchObject({ claimed: 1, processed: 1 });
    expect(await deliveryOfEmail(database, childEmail)).toMatchObject({
      state: "done",
      thread_match: "in_reply_to",
      conversation_id: reserved.planned_conversation_id,
    });

    parentHeld.release();
    expect(await parentRun).toMatchObject({ claimed: 1, processed: 1 });
    const { conversationId } = await expectOneThread(mailbox, [parentEmail, childEmail]);
    expect(conversationId).toBe(reserved.planned_conversation_id);
  });

  it("(ii) reaches back from a parent fetched after its follow-up was fully processed", async () => {
    const { mailbox, domain } = await seedSupportMailbox(database);
    const target = { mailbox, domain: domain.domain };
    const [a, b] = [workerNode(), workerNode()];
    const fetchHeld = a.seams.pauseAt("receiver.fetchMessage", "before");

    const parentEmail = await receive(a, PARENT, target);
    const parentRun = drainOne(a);
    await fetchHeld.reached;

    const childEmail = await receive(b, CHILD, target);
    expect(await drainOne(b)).toMatchObject({ processed: 1 });
    const child = await deliveryOfEmail(database, childEmail);
    expect(child).toMatchObject({ state: "done", thread_match: "new_thread" });
    expect(await deliveriesOfEmail(database, parentEmail)).toEqual([]);

    fetchHeld.release();
    expect(await parentRun).toMatchObject({ processed: 1 });
    expect(await deliveryOfEmail(database, parentEmail)).toMatchObject({
      thread_match: "reverse_reference",
      conversation_id: child.conversation_id,
    });
    await expectOneThread(mailbox, [parentEmail, childEmail]);
  });

  it("(iii) resumes a delivery that crashed between resolve and ingest with its reserved ids", async () => {
    const { mailbox, domain } = await seedSupportMailbox(database);
    const target = { mailbox, domain: domain.domain };
    const [a, b] = [workerNode(), workerNode()];
    a.seams.crashAt({ seam: "threadProtocol.run", when: "after", nth: 1 });

    const parentEmail = await receive(a, PARENT, target);
    expect(await drainOne(a)).toMatchObject({ claimed: 1, errored: 1 });
    expect(a.seams.hasCrashed).toBe(true);
    const reserved = await deliveryOfEmail(database, parentEmail);
    expect(reserved).toMatchObject({ state: "resolved", conversation_id: null });
    expect(await eventOfEmail(database, parentEmail)).toMatchObject({ state: "processing", attempts: 1 });

    // The follow-up arrives while the parent's claim is still leased to the dead worker.
    const childEmail = await receive(b, CHILD, target);
    expect(await drainOne(b)).toMatchObject({ processed: 1 });
    expect(await deliveryOfEmail(database, childEmail)).toMatchObject({
      thread_match: "in_reply_to",
      conversation_id: reserved.planned_conversation_id,
    });

    expect(await recoverWith(b, parentEmail)).toMatchObject({ recoveredLeases: 1, drained: 1 });
    expect(await eventOfEmail(database, parentEmail)).toMatchObject({ state: "processed", attempts: 2 });
    const { deliveries } = await expectOneThread(mailbox, [parentEmail, childEmail]);
    expect(deliveries[0]).toMatchObject({
      conversation_id: reserved.planned_conversation_id,
      message_id: reserved.planned_message_id,
    });
  });

  it("(iv) indexes a delivery that crashed between ingest and index without a second message", async () => {
    const { mailbox, domain } = await seedSupportMailbox(database);
    const target = { mailbox, domain: domain.domain };
    const [a, b] = [workerNode(), workerNode()];
    a.seams.crashAt({ seam: "chat.ingest", when: "after" });

    const parentEmail = await receive(a, PARENT, target);
    expect(await drainOne(a)).toMatchObject({ errored: 1 });
    const ingested = await deliveryOfEmail(database, parentEmail);
    // Host ingest committed; the delivery never heard back, so it is still only reserved.
    expect(ingested).toMatchObject({ state: "resolved", conversation_id: null });
    expect(await customerMessagesOf(database, ingested.planned_conversation_id ?? "")).toHaveLength(1);
    expect(await threadLinksOf(database, mailbox)).toEqual([]);

    const childEmail = await receive(b, CHILD, target);
    expect(await drainOne(b)).toMatchObject({ processed: 1 });

    expect(await recoverWith(b, parentEmail)).toMatchObject({ recoveredLeases: 1, drained: 1 });
    const { deliveries } = await expectOneThread(mailbox, [parentEmail, childEmail]);
    expect(deliveries[0].message_id).toBe(ingested.planned_message_id);
  });

  it("(v) gives two deliveries racing to start the same thread one conversation", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { mailbox, domain } = await seedSupportMailbox(database);
      const target = { mailbox, domain: domain.domain };
      const [a, b] = [workerNode(), workerNode()];
      // Both deliveries are fetched before either resolves, so they meet at the thread lock.
      const fetched = barrier(2);
      a.seams.on("inbound.recordFetched", "after", () => fetched.arrive());
      b.seams.on("inbound.recordFetched", "after", () => fetched.arrive());

      const parentEmail = await receive(a, PARENT, target);
      const childEmail = await receive(a, CHILD, target);
      const results = await Promise.all([drainOne(a), drainOne(b)]);

      expect(results.map((result) => [result.claimed, result.processed])).toEqual([[1, 1], [1, 1]]);
      const { deliveries } = await expectOneThread(mailbox, [parentEmail, childEmail]);
      expect(deliveries.filter((delivery) => delivery.thread_match === "new_thread")).toHaveLength(1);
    }
  });

  it("(vi) joins a parent that arrives after its follow-up is done", async () => {
    const { mailbox, domain } = await seedSupportMailbox(database);
    const target = { mailbox, domain: domain.domain };
    const [a, b] = [workerNode(), workerNode()];

    const childEmail = await receive(b, CHILD, target);
    expect(await drainOne(b)).toMatchObject({ processed: 1 });
    const child = await deliveryOfEmail(database, childEmail);
    expect(child).toMatchObject({ state: "done", thread_match: "new_thread" });

    const parentEmail = await receive(a, PARENT, target);
    expect(await drainOne(a)).toMatchObject({ processed: 1 });
    const parent = await deliveryOfEmail(database, parentEmail);
    expect(parent).toMatchObject({
      thread_match: "reverse_reference",
      conversation_id: child.conversation_id,
    });
    await expectOneThread(mailbox, [parentEmail, childEmail]);
    // The child left a placeholder for the parent's Message-Id; the parent's own entry replaced it.
    expect(await database.queryOne(
      "SELECT direction, origin, message_id, inbound_delivery_id, subject FROM email_thread_messages WHERE mailbox_id = $1 AND rfc_message_id = $2",
      [mailbox.id, PARENT_ID],
    )).toEqual({ direction: "inbound", origin: "inbound", message_id: parent.message_id, inbound_delivery_id: parent.id, subject: expect.any(String) });
  });

  it("(vii) fans one message for two mailboxes out to one conversation in each", async () => {
    const { workspaceId, mailbox: support, domain } = await seedSupportMailbox(database);
    const sales = await seedMailbox(database, { workspaceId, domain, local: "sales" });
    const a = workerNode();

    const emailId = await receive(a, "mime/two-mailbox.eml", { mailbox: support, domain: domain.domain }, [
      relayAddressOf(support),
      relayAddressOf(sales),
    ]);
    expect(await drainOne(a)).toMatchObject({ processed: 1 });

    const deliveries = await deliveriesOfEmail(database, emailId);
    expect(deliveries.map((delivery) => [delivery.mailbox_id, delivery.rfc_message_id, delivery.thread_match, delivery.state]))
      .toEqual(expect.arrayContaining([
        [support.id, "<msg-0020@example.test>", "new_thread", "done"],
        [sales.id, "<msg-0020@example.test>", "new_thread", "done"],
      ]));
    expect(deliveries).toHaveLength(2);
    const [supportConversations, salesConversations] = await Promise.all([
      conversationsOfMailbox(database, support),
      conversationsOfMailbox(database, sales),
    ]);
    expect(supportConversations).toHaveLength(1);
    expect(salesConversations).toHaveLength(1);
    expect(supportConversations[0]).not.toBe(salesConversations[0]);
  });

  it("(vii) threads the same Message-Id independently per mailbox when each forwards it separately", async () => {
    const { workspaceId, mailbox: support, domain } = await seedSupportMailbox(database);
    const sales = await seedMailbox(database, { workspaceId, domain, local: "sales" });
    const [a, b] = [workerNode(), workerNode()];

    const parentForSupport = await receive(a, PARENT, { mailbox: support, domain: domain.domain });
    const parentForSales = await receive(a, PARENT, { mailbox: sales, domain: domain.domain });
    await Promise.all([drainOne(a), drainOne(b)]);
    const supportParent = await deliveryOfEmail(database, parentForSupport);
    const salesParent = await deliveryOfEmail(database, parentForSales);
    expect([supportParent.thread_match, salesParent.thread_match]).toEqual(["new_thread", "new_thread"]);

    // The follow-up reaches only the support mailbox and joins only its thread.
    const childForSupport = await receive(b, CHILD, { mailbox: support, domain: domain.domain });
    expect(await drainOne(b)).toMatchObject({ processed: 1 });

    await expectOneThread(support, [parentForSupport, childForSupport]);
    const salesConversations = await conversationsOfMailbox(database, sales);
    expect(salesConversations).toEqual([salesParent.conversation_id]);
    expect(salesConversations[0]).not.toBe(supportParent.conversation_id);
    expect(await customerMessagesOf(database, salesParent.conversation_id ?? "")).toHaveLength(1);
    expect(await indexedMessageIdsOf(database, salesParent.conversation_id ?? "")).toEqual([PARENT_ID]);
  });

  it("(viii) stops a worker whose lease was reclaimed while it held a fetched snapshot: one conversation, one message", async () => {
    const { mailbox, domain } = await seedSupportMailbox(database);
    const [a, b] = [workerNode(), workerNode()];
    const stalled = a.seams.pauseAt("inbound.recordFetched", "after");

    const parentEmail = await receive(a, PARENT, { mailbox, domain: domain.domain });
    const staleRun = drainOne(a);
    await stalled.reached;
    await expireLease(database, (await eventOfEmail(database, parentEmail)).id);
    expect(await drainOne(b)).toMatchObject({ claimed: 1, processed: 1 });

    stalled.release();
    expect(await staleRun).toMatchObject({ claimed: 1, superseded: 1, processed: 0 });

    const conversations = await conversationsOfMailbox(database, mailbox);
    expect(conversations).toHaveLength(1);
    expect(await customerMessagesOf(database, conversations[0])).toHaveLength(1);
    expect(await deliveryOfEmail(database, parentEmail)).toMatchObject({ state: "done", conversation_id: conversations[0] });
    expect(await eventOfEmail(database, parentEmail)).toMatchObject({ state: "processed", attempts: 2 });
    expect(a.logger.messages()).toContain("email_inbound_claim_lost");
  });

  it("(ix) indexes once when two workers hold the same ingested snapshot: the review revision moves once", async () => {
    const { mailbox, domain } = await seedSupportMailbox(database, { engagementMode: "draft", withAgent: true });
    const drafting = () => {
      const node = createWorkerNode(suite.url, { spoolDir: spool.dir, supportedModes: ["operator_only", "draft"] });
      nodes.push(node);
      return node;
    };
    const [a, b] = [drafting(), drafting()];
    const stalled = a.seams.pauseAt("inbound.recordIngested", "after");

    const parentEmail = await receive(a, PARENT, { mailbox, domain: domain.domain });
    const staleRun = drainOne(a);
    await stalled.reached;
    await expireLease(database, (await eventOfEmail(database, parentEmail)).id);
    expect(await drainOne(b)).toMatchObject({ claimed: 1, processed: 1 });

    stalled.release();
    expect(await staleRun).toMatchObject({ claimed: 1, superseded: 1 });

    const delivery = await deliveryOfEmail(database, parentEmail);
    expect(delivery).toMatchObject({ state: "done", disposition: "run_review_turn" });
    expect(await database.queryOne<{ review_revision: number }>(
      "SELECT review_revision FROM email_thread_links WHERE conversation_id = $1",
      [delivery.conversation_id],
    )).toEqual({ review_revision: 1 });
    expect(await eventOfEmail(database, parentEmail)).toMatchObject({ state: "processed", attempts: 2 });
  });

  it.todo("joins a reply whose forwarder rewrote its threading headers by the plus token (mime/forwarder-rewrite.eml, after T010)");
});
