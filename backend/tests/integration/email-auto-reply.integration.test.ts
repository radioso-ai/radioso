import type { ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { EMAIL_SEND_ACTION_TYPE, emailSendKey } from "../../src/modules/emailChannel/public.js";
import type { Database } from "../../src/shared/infra/database.js";
import {
  createEmailChannelDatabase,
  createSpool,
  createWorkerNode,
  deliveryOfEmail,
  postReceived,
  readFixture,
  relayAddressOf,
} from "./support/emailChannelHarness.js";
import {
  counterValue,
  createApiNode,
  messagesOf,
  openEmailConversation,
  outboxActionsOf,
  providerAcceptsUnder,
  sendIntentOf,
} from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// US6 against Postgres (research B9, FR-032): on an `auto` mailbox a grounded, complete answer is
// queued as `queued_auto` with its `email.send` keyed by the held reply, and no message is written
// until dispatch materializes it — once, as the agent's mail, with `Auto-Submitted: auto-generated`.
// A takeover or a downgrade between queue and materialize supersedes it, and authority that fails
// without one (an unverified domain) returns it to a teammate, so neither sends. A headerless
// responder stops at the thread's send budget with one approval flag (SC-006, AS5.4); a human-owned
// conversation runs no turn (AS6.3); and a queued reply whose `email.send` gave up before it
// materialized returns to a teammate at the next sweep instead of staying queued forever.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const AUTO = ["operator_only", "draft", "auto"] as const;
const ANSWER = "Hi Alice, you can update your billing address under Settings > Billing.";
const FOLLOW_UP = "mime/pre-reply-follow-up.eml";
/** The action outbox's lease, which the sweep waits out before it looks at a queued send. */
const QUEUED_PAST_LEASE = "10 minutes";

type WorkerNode = ReturnType<typeof createWorkerNode>;
type Conversation = Awaited<ReturnType<typeof openEmailConversation>>;

interface HeldReplyRow {
  id: string;
  state: string;
  hold_reason: string;
  release_kind: string | null;
  superseded_reason: string | null;
  released_message_id: string | null;
}

describeIntegration("email auto reply (Postgres, research B9)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Awaited<ReturnType<typeof createSpool>>;
  let api: ReturnType<typeof createApiNode>;
  const nodes: WorkerNode[] = [];
  /** Every review turn the host ran, across this suite's workers. */
  const turns: ConnectorRespondInput[] = [];

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "auto_reply");
    database = suite.database;
    spool = await createSpool();
    api = createApiNode(database, { spoolDir: spool.dir });
  }, 60_000);

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((node) => node.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await spool?.remove();
    await suite?.close();
  }, 30_000);

  /** A review that answers grounded and complete at the conversation's ownership: the decision publishes it. */
  const answering = async (input: ConnectorRespondInput): Promise<ConnectorTurnResult> => {
    turns.push(input);
    const ownership = await database.queryOptional<{ version: number }>(
      "SELECT version FROM conversation_ownership WHERE conversation_id = $1",
      [input.conversationId],
    );
    return {
      kind: "draft",
      conversationId: input.conversationId,
      ownershipVersion: ownership?.version ?? 0,
      facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false }, suppressedEffects: [], citationCount: 1 },
      draft: { text: ANSWER, presentation: { citations: [] } },
    };
  };

  const workerNode = (): WorkerNode => {
    const node = createWorkerNode(suite.url, { spoolDir: spool.dir, supportedModes: AUTO, respond: answering });
    nodes.push(node);
    return node;
  };

  const heldRepliesOf = (conversationId: string) =>
    database.query<HeldReplyRow>(
      `SELECT id, state, hold_reason, release_kind, superseded_reason, released_message_id
         FROM held_replies WHERE conversation_id = $1 ORDER BY created_at, id`,
      [conversationId],
    );

  const agentMessagesOf = async (conversationId: string) =>
    (await messagesOf(database, conversationId)).filter((message) => message.role === "assistant");

  const intentsOf = (conversationId: string) =>
    database.query<{ id: string; trigger: string; state: string }>(
      "SELECT id, trigger, state FROM email_send_intents WHERE conversation_id = $1 ORDER BY created_at, id",
      [conversationId],
    );

  const emailSendsOf = async (conversationId: string) =>
    (await outboxActionsOf(database, conversationId)).filter((action) => action.type === EMAIL_SEND_ACTION_TYPE);

  /** The provider accepts under every `email.send` the conversation queued: what the customer received. */
  const acceptsOf = async (conversationId: string) => {
    const keys = (await emailSendsOf(conversationId)).flatMap((action) => (action.idempotency_key ? [action.idempotency_key] : []));
    return (await Promise.all(keys.map((key) => providerAcceptsUnder(spool.dir, key)))).flat();
  };

  /** The held replies a teammate is asked to decide on in the conversation: its `approval` attention. */
  const approvalsOf = async (conversation: Conversation) =>
    (await api.heldReplies.list(conversation.teammate, { attention: "open", limit: 50 })).items
      .filter((item) => item.conversationId === conversation.conversationId);

  const autoSendsSinceRenewalOf = async (conversationId: string): Promise<number> =>
    (await database.queryOne<{ auto_sends_since_renewal: number }>(
      "SELECT auto_sends_since_renewal FROM email_thread_links WHERE conversation_id = $1",
      [conversationId],
    )).auto_sends_since_renewal;

  /** Brings the thread's scheduled review due and runs it through `worker`. */
  const review = async (worker: WorkerNode, conversationId: string): Promise<void> => {
    await database.execute(
      "UPDATE email_thread_links SET review_due_at = now() - interval '1 second' WHERE conversation_id = $1 AND review_due_at IS NOT NULL",
      [conversationId],
    );
    expect(await worker.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });
  };

  /** The customer writes again on the thread, received and processed through `worker`; returns the provider's email id. */
  const followUp = async (worker: WorkerNode, conversation: Conversation, nth = 1): Promise<string> => {
    const raw = (await readFixture(FOLLOW_UP, { relayToken: conversation.mailbox.relayToken, domain: conversation.domain.domain }))
      .toString("latin1")
      .replace("Message-ID: <msg-0002@example.test>", `Message-ID: <follow-up-${nth}@example.test>`)
      .replace("One more thing", `Message ${nth}`);
    const emailId = await spool.put(Buffer.from(raw, "latin1"));
    expect(await postReceived(await worker.webhook(), { emailId, receivedFor: [relayAddressOf(conversation.mailbox)] })).toBe(200);
    expect(await worker.worker.drain({ maxJobs: 5, stage: "inbound" })).toMatchObject({ processed: 1, errored: 0 });
    return emailId;
  };

  /**
   * Alice's first contact on an `auto` mailbox, reviewed: one `queued_auto` held reply with its
   * `email.send` queued under the held reply's key, and no agent message yet.
   */
  const queuedAutoReply = async (worker = workerNode()) => {
    const conversation = await openEmailConversation(database, { node: worker, spool }, { engagementMode: "auto", withAgent: true });
    const { conversationId } = conversation;
    await review(worker, conversationId);
    const [held, ...others] = await heldRepliesOf(conversationId);
    expect(others).toEqual([]);
    expect(held).toMatchObject({ state: "queued_auto", released_message_id: null });
    expect(await agentMessagesOf(conversationId)).toEqual([]);
    const key = emailSendKey.heldReply(held.id);
    expect(await emailSendsOf(conversationId)).toEqual([expect.objectContaining({
      idempotency_key: key,
      status: "pending",
      payload: expect.objectContaining({ trigger: "auto_reply", heldReplyId: held.id, messageId: null }),
    })]);
    expect(await autoSendsSinceRenewalOf(conversationId)).toBe(1);
    return { ...conversation, worker, heldReplyId: held.id, key };
  };

  /** Nothing reached the customer: no agent message, no send intent, no provider accept. */
  const expectNothingSent = async (conversationId: string, key: string): Promise<void> => {
    expect(await agentMessagesOf(conversationId)).toEqual([]);
    expect(await intentsOf(conversationId)).toEqual([]);
    expect(await providerAcceptsUnder(spool.dir, key)).toEqual([]);
  };

  it("materializes a published answer at dispatch into one agent message and one send, with Auto-Submitted (AS6.1, AS5.7)", async () => {
    const queued = await queuedAutoReply();
    const { conversationId, worker, heldReplyId, key } = queued;

    expect(await worker.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

    const [message, ...otherMessages] = await agentMessagesOf(conversationId);
    expect(otherMessages).toEqual([]);
    expect(message).toMatchObject({ role: "assistant", content: ANSWER });
    expect(await heldRepliesOf(conversationId)).toEqual([
      expect.objectContaining({ id: heldReplyId, state: "released", release_kind: "auto", released_message_id: message.id }),
    ]);
    // The message carries its send from the moment it exists: one intent, under the held reply's key.
    const intent = await sendIntentOf(database, message.id);
    expect(intent).toMatchObject({ trigger: "auto_reply", authorKind: "agent", heldReplyId, idempotencyKey: key, state: "accepted" });
    const [accept, ...otherAccepts] = await providerAcceptsUnder(spool.dir, key);
    expect(otherAccepts).toEqual([]);
    expect(accept.message.to).toBe("alice@example.test");
    expect(accept.message.text).toContain(ANSWER);
    expect(accept.message.threading?.autoSubmitted).toBe("auto-generated");
    expect(counterValue(worker.metrics, "email_auto_dispatch_total", { result: "materialized" })).toBe(1);
    expect(await approvalsOf(queued)).toEqual([]);

    // Dispatched once: a later drain finds nothing to send.
    expect(await worker.dispatch()).toMatchObject({ dispatched: 0 });
    expect(await providerAcceptsUnder(spool.dir, key)).toHaveLength(1);
    expect(await emailSendsOf(conversationId)).toEqual([expect.objectContaining({ status: "dispatched", attempts: 1 })]);
  });

  it("sends nothing for a reply a takeover superseded between queue and materialize", async () => {
    const { conversationId, worker, heldReplyId, key, teammate } = await queuedAutoReply();

    expect((await api.takeOver(teammate, conversationId)).status).toBe(200);
    expect(await heldRepliesOf(conversationId)).toEqual([
      expect.objectContaining({ id: heldReplyId, state: "superseded", superseded_reason: "takeover" }),
    ]);

    expect(await worker.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

    await expectNothingSent(conversationId, key);
    expect((await heldRepliesOf(conversationId)).map((held) => held.state)).toEqual(["superseded"]);
    expect(counterValue(worker.metrics, "email_auto_dispatch_total", { result: "not_queued" })).toBe(1);
  });

  it("sends nothing for a reply a downgrade superseded between queue and materialize (AS5.8)", async () => {
    const queued = await queuedAutoReply();
    const { conversationId, worker, heldReplyId, key, teammate, workspaceId, mailbox } = queued;

    // The settings path: the policy change supersedes the mailbox's live drafts in its own transaction.
    await api.channel.mailboxes.update({ userId: teammate.userId }, workspaceId, mailbox.id, { engagementMode: "draft" });
    expect(await heldRepliesOf(conversationId)).toEqual([
      expect.objectContaining({ id: heldReplyId, state: "superseded", superseded_reason: "policy_changed" }),
    ]);

    expect(await worker.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

    await expectNothingSent(conversationId, key);
    expect((await heldRepliesOf(conversationId)).map((held) => held.state)).toEqual(["superseded"]);
    expect(counterValue(worker.metrics, "email_auto_dispatch_total", { result: "not_queued" })).toBe(1);
  });

  it("returns a reply whose authority failed without a supersede to a teammate as pending, sending nothing (AS6.4)", async () => {
    const queued = await queuedAutoReply();
    const { conversationId, worker, heldReplyId, key, domain } = queued;

    // The provider stops vouching for the domain; nothing supersedes the queued reply.
    await database.execute("UPDATE email_domains SET sending_status = 'failed' WHERE id = $1", [domain.id]);
    expect(await worker.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });

    await expectNothingSent(conversationId, key);
    expect(await heldRepliesOf(conversationId)).toEqual([expect.objectContaining({
      id: heldReplyId,
      state: "pending",
      hold_reason: "authority_changed",
      release_kind: null,
      released_message_id: null,
    })]);
    expect(await approvalsOf(queued)).toEqual([expect.objectContaining({ id: heldReplyId, state: "pending", holdReason: "authority_changed" })]);
    expect(counterValue(worker.metrics, "email_auto_dispatch_total", { result: "returned_to_pending" })).toBe(1);
    expect(worker.logger.messages()).toContain("email_auto_send_returned_to_pending");
  });

  it("stops a headerless responder at the thread send budget with one approval flag (SC-006, AS5.4)", async () => {
    const worker = workerNode();
    const reviewsBefore = turns.length;
    const queued = await queuedAutoReply(worker);
    const { conversationId, mailbox } = queued;
    expect(mailbox.threadSendBudget).toBe(3);
    await worker.dispatch();

    // The responder answers every email at once, with no automation header to recognise it by.
    for (let reply = 1; reply <= 5; reply += 1) {
      await followUp(worker, queued, reply);
      await review(worker, conversationId);
      await worker.dispatch();
    }

    expect(turns.length - reviewsBefore).toBe(6);
    expect(await acceptsOf(conversationId)).toHaveLength(3);
    expect(await agentMessagesOf(conversationId)).toHaveLength(3);
    // Customer mail never renewed the budget, and a refused publish spent none of it.
    expect(await autoSendsSinceRenewalOf(conversationId)).toBe(3);
    const held = await heldRepliesOf(conversationId);
    expect(held.map((row) => [row.state, row.state === "pending" ? row.hold_reason : row.release_kind ?? row.superseded_reason])).toEqual([
      ["released", "auto"],
      ["released", "auto"],
      ["released", "auto"],
      ["superseded", "newer_inbound"],
      ["superseded", "newer_inbound"],
      ["pending", "send_budget"],
    ]);
    const approvals = await approvalsOf(queued);
    expect(approvals).toEqual([expect.objectContaining({ state: "pending", holdReason: "send_budget" })]);
    expect(approvals[0].id).toBe(held.at(-1)?.id);
  }, 60_000);

  it("runs no turn for a human-owned conversation on an auto mailbox (AS6.3)", async () => {
    const queued = await queuedAutoReply();
    const { conversationId, worker, teammate } = queued;
    await worker.dispatch();
    expect((await api.takeOver(teammate, conversationId)).status).toBe(200);
    const reviewsBefore = turns.length;

    const emailId = await followUp(worker, queued);
    expect(await deliveryOfEmail(database, emailId)).toMatchObject({ state: "done", conversation_id: conversationId, disposition_reason: "human_owned" });
    expect(await database.queryOne("SELECT review_due_at FROM email_thread_links WHERE conversation_id = $1", [conversationId])).toEqual({ review_due_at: null });
    expect(await worker.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 0 });

    expect(turns.length).toBe(reviewsBefore);
    expect((await heldRepliesOf(conversationId)).map((held) => held.state)).toEqual(["released"]);
    expect(await agentMessagesOf(conversationId)).toHaveLength(1);
    expect(await acceptsOf(conversationId)).toHaveLength(1);
  });

  it("returns a queued reply whose email.send gave up before it materialized to a teammate at the next sweep", async () => {
    const failing = workerNode();
    failing.seams.on("heldReplies.materializeAuto", "before", () => {
      throw new Error("database unavailable");
    });
    const abandoned = await queuedAutoReply(failing);
    const makeRetryDue = () =>
      database.execute(
        "UPDATE routine_action_requests SET next_attempt_at = now() - interval '1 second' WHERE conversation_id = $1 AND status = 'pending'",
        [abandoned.conversationId],
      );
    // The outbox retries the dispatch until it gives up; the reply never materialized, so nothing settles it.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await makeRetryDue();
      expect(await failing.dispatch()).toMatchObject(attempt < 5 ? { retried: 1 } : { failed: 1 });
    }
    expect(await emailSendsOf(abandoned.conversationId)).toEqual([expect.objectContaining({ status: "failed", attempts: 5 })]);
    expect((await heldRepliesOf(abandoned.conversationId)).map((held) => held.state)).toEqual(["queued_auto"]);
    expect(await approvalsOf(abandoned)).toEqual([]);

    // Another reply is queued too, its own dispatch still to come.
    const sweeper = workerNode();
    const live = await queuedAutoReply(sweeper);

    // Within the outbox's lease the sweep leaves both alone.
    expect(await sweeper.worker.sweep({ maxJobs: 10 })).toMatchObject({ returnedAbandonedAutoSends: 0 });
    for (const { conversationId } of [abandoned, live]) {
      await database.execute(`UPDATE held_replies SET created_at = now() - interval '${QUEUED_PAST_LEASE}' WHERE conversation_id = $1`, [conversationId]);
    }

    expect(await sweeper.worker.sweep({ maxJobs: 10 })).toMatchObject({ returnedAbandonedAutoSends: 1 });
    expect(await heldRepliesOf(abandoned.conversationId)).toEqual([expect.objectContaining({
      id: abandoned.heldReplyId,
      state: "pending",
      hold_reason: "authority_changed",
      released_message_id: null,
    })]);
    expect(await approvalsOf(abandoned)).toEqual([expect.objectContaining({ id: abandoned.heldReplyId, holdReason: "authority_changed" })]);
    await expectNothingSent(abandoned.conversationId, abandoned.key);
    expect(sweeper.logger.messages()).toContain("email_abandoned_auto_sends_returned");
    // Returned once; the live reply is its dispatch's to send.
    expect(await sweeper.worker.sweep({ maxJobs: 10 })).toMatchObject({ returnedAbandonedAutoSends: 0 });
    expect((await heldRepliesOf(live.conversationId)).map((held) => held.state)).toEqual(["queued_auto"]);

    expect(await sweeper.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });
    expect((await heldRepliesOf(live.conversationId)).map((held) => held.state)).toEqual(["released"]);
    expect(await providerAcceptsUnder(spool.dir, live.key)).toHaveLength(1);
  }, 60_000);
});
