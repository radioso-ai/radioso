import type { ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";

import type { EmailReviewChecks } from "../../src/modules/connectors/plugins/email/emailReviewRunner.js";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import type { Database } from "../../src/shared/infra/database.js";
import {
  activityOf,
  conversationsOfMailbox,
  createEmailChannelDatabase,
  createSpool,
  createWorkerNode,
  customerMessagesOf,
  postReceived,
  readFixture,
  relayAddressOf,
  seedSupportMailbox,
} from "./support/emailChannelHarness.js";
import { outboxActionsOf } from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Research B17 against Postgres: a review completes only its own revision, so a worker overtaken by
// newer mail leaves the newer review due and holds its own draft superseded; a worker that dies
// after holding a draft and before completing leaves the review ref behind, so the next claim
// completes without running the model again; a worker stalled past its lease does nothing once
// another claim took R over, even one that publishes only after the claim that took over set R
// aside; and mail set aside is noted and completed in one transaction.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const FIRST = "mime/first-contact.eml";
const FOLLOW_UP = "mime/pre-reply-follow-up.eml";
const DRAFTING = ["operator_only", "draft"] as const;
const AUTO = ["operator_only", "draft", "auto"] as const;

type WorkerNode = ReturnType<typeof createWorkerNode>;
type Respond = (input: ConnectorRespondInput) => Promise<ConnectorTurnResult>;

interface ReviewLink {
  review_revision: number;
  review_completed_revision: number;
  review_due_at: Date | null;
  review_lease_until: Date | null;
}

interface HeldReplyRow {
  state: string;
  superseded_reason: string | null;
  review_ref: string;
  answers_message_id: string;
  draft_text: string;
}

const draft = (input: ConnectorRespondInput, text: string): ConnectorTurnResult => ({
  kind: "draft",
  conversationId: input.conversationId,
  ownershipVersion: 0,
  facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false }, suppressedEffects: [], citationCount: 1 },
  draft: { text, presentation: { citations: [] } },
});

describeIntegration("email review revisions (Postgres, research B17)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Awaited<ReturnType<typeof createSpool>>;
  const nodes: WorkerNode[] = [];

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "review_revision");
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

  const workerNode = (respond?: Respond, checks?: EmailReviewChecks, supportedModes: readonly ("operator_only" | "draft" | "auto")[] = DRAFTING): WorkerNode => {
    const node = createWorkerNode(suite.url, { spoolDir: spool.dir, supportedModes, respond, checks });
    nodes.push(node);
    return node;
  };

  /** Lets a stalled or dead worker's review lease run out, as time passing would. */
  const expireReviewLease = async (conversationId: string) => {
    await database.execute("UPDATE email_thread_links SET review_lease_until = now() - interval '1 second' WHERE conversation_id = $1", [conversationId]);
  };

  /** The review's model checks with the triage finding that the mail needs no reply. */
  const noReplyNeeded: EmailReviewChecks = {
    replyTriage: { assess: async () => "no" },
    replyCompleteness: { assess: async () => ({ completeness: "complete", unansweredAsks: 0 }) },
  };

  const setAsideNotesOf = async (conversationId: string) =>
    (await activityOf(database, conversationId)).filter((entry) => entry.kind === "channel_exception" && entry.detail.code === "no_reply_needed");

  const draftMailbox = async () => {
    const seeded = await seedSupportMailbox(database, { engagementMode: "draft", withAgent: true });
    return { mailbox: seeded.mailbox, domain: seeded.domain.domain };
  };

  /** Posts a fixture's webhook through `via` and runs stage 1 for it, which schedules the thread's review. */
  const receiveAndIngest = async (via: WorkerNode, fixture: string, target: Awaited<ReturnType<typeof draftMailbox>>) => {
    const emailId = await spool.put(await readFixture(fixture, { relayToken: target.mailbox.relayToken, domain: target.domain }));
    expect(await postReceived(await via.webhook(), { emailId, receivedFor: [relayAddressOf(target.mailbox)] })).toBe(200);
    expect(await via.worker.drain({ maxJobs: 5, stage: "inbound" })).toMatchObject({ processed: 1, errored: 0 });
  };

  /** Brings every scheduled review due by the database's clock, whatever the worker's says. */
  const makeReviewsDue = async (conversationId: string) => {
    await database.execute(
      "UPDATE email_thread_links SET review_due_at = now() - interval '1 second' WHERE conversation_id = $1 AND review_due_at IS NOT NULL",
      [conversationId],
    );
  };

  const reviewLink = (conversationId: string) =>
    database.queryOne<ReviewLink>(
      "SELECT review_revision, review_completed_revision, review_due_at, review_lease_until FROM email_thread_links WHERE conversation_id = $1",
      [conversationId],
    );

  const heldRepliesOf = (conversationId: string) =>
    database.query<HeldReplyRow>(
      `SELECT state, superseded_reason, review_ref, answers_message_id, draft_text
         FROM held_replies WHERE conversation_id = $1 ORDER BY created_at, id`,
      [conversationId],
    );

  it("lets newer mail overtake a running review: R's draft is superseded, R+1 stays due and runs, one current draft", async () => {
    const target = await draftMailbox();
    const intake = workerNode();
    await receiveAndIngest(intake, FIRST, target);
    const [conversationId] = await conversationsOfMailbox(database, target.mailbox);
    await makeReviewsDue(conversationId);

    const respond = vi.fn<Respond>()
      .mockImplementationOnce(async (input) => {
        // While revision 1 is being reviewed, the customer writes again: revision 2.
        await receiveAndIngest(intake, FOLLOW_UP, target);
        return draft(input, "Answers the first message only.");
      })
      .mockImplementationOnce(async (input) => draft(input, "Answers both messages."));
    const reviewer = workerNode(respond);

    expect(await reviewer.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });

    const [first, second] = await customerMessagesOf(database, conversationId);
    expect(respond.mock.calls[0][0]).toMatchObject({ conversationId, respondToMessageId: first.id, executionMode: "review" });
    expect(await heldRepliesOf(conversationId)).toEqual([
      expect.objectContaining({ state: "superseded", superseded_reason: "newer_inbound", review_ref: `email:${conversationId}:1`, answers_message_id: first.id }),
    ]);
    const overtaken = await reviewLink(conversationId);
    expect(overtaken).toMatchObject({ review_revision: 2, review_completed_revision: 0, review_lease_until: null });
    expect(overtaken.review_due_at).not.toBeNull();

    expect(await reviewer.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });

    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1][0]).toMatchObject({ respondToMessageId: second.id });
    const held = await heldRepliesOf(conversationId);
    expect(held.filter((row) => row.state === "pending")).toEqual([
      expect.objectContaining({ review_ref: `email:${conversationId}:2`, answers_message_id: second.id, draft_text: "Answers both messages." }),
    ]);
    expect(await reviewLink(conversationId)).toMatchObject({ review_revision: 2, review_completed_revision: 2, review_due_at: null });
    // The draft never became a message: the conversation holds the customer's two messages only.
    expect((await customerMessagesOf(database, conversationId)).map((message) => message.role)).toEqual(["user", "user"]);
  }, 60_000);

  it("completes without a second turn after a worker died between holding the draft and completing", async () => {
    const target = await draftMailbox();
    const intake = workerNode();
    await receiveAndIngest(intake, FIRST, target);
    const [conversationId] = await conversationsOfMailbox(database, target.mailbox);
    await makeReviewsDue(conversationId);

    const dyingRespond = vi.fn<Respond>(async (input) => draft(input, "Held before the crash."));
    const dying = workerNode(dyingRespond);
    dying.seams.crashAt({ seam: "threads.completeReview", when: "before" });

    expect(await dying.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });
    expect(dying.seams.hasCrashed).toBe(true);
    expect(await heldRepliesOf(conversationId)).toEqual([expect.objectContaining({ state: "pending", review_ref: `email:${conversationId}:1` })]);
    const stranded = await reviewLink(conversationId);
    expect(stranded).toMatchObject({ review_revision: 1, review_completed_revision: 0 });
    expect(stranded.review_lease_until).not.toBeNull();

    // The dead worker's lease runs out; another worker claims the same revision.
    await database.execute("UPDATE email_thread_links SET review_lease_until = now() - interval '1 second' WHERE conversation_id = $1", [conversationId]);
    const recoveringRespond = vi.fn<Respond>(async (input) => draft(input, "A second turn must not run."));
    const recovering = workerNode(recoveringRespond);

    expect(await recovering.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });

    expect(dyingRespond).toHaveBeenCalledOnce();
    expect(recoveringRespond).not.toHaveBeenCalled();
    expect(await heldRepliesOf(conversationId)).toEqual([
      expect.objectContaining({ state: "pending", review_ref: `email:${conversationId}:1`, draft_text: "Held before the crash." }),
    ]);
    expect(await reviewLink(conversationId)).toMatchObject({ review_revision: 1, review_completed_revision: 1, review_due_at: null, review_lease_until: null });
  }, 60_000);

  it("leaves R's draft alone when a claim stalled past its lease after the review-ref lookup resumes (research B17)", async () => {
    const target = await draftMailbox();
    const intake = workerNode();
    await receiveAndIngest(intake, FIRST, target);
    const [conversationId] = await conversationsOfMailbox(database, target.mailbox);
    await makeReviewsDue(conversationId);

    const staleRespond = vi.fn<Respond>(async (input) => draft(input, "From the stalled claim."));
    const stalled = workerNode(staleRespond);
    const paused = stalled.seams.pauseAt("heldReplies.findByReviewRef", "after");
    const staleRun = stalled.worker.drain({ maxJobs: 5, stage: "review" });
    await paused.reached;

    // The stalled claim's lease runs out; another worker claims R, holds its draft and completes R.
    await expireReviewLease(conversationId);
    const takeover = workerNode(async (input) => draft(input, "From the claim that took over."));
    expect(await takeover.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });

    paused.release();
    expect(await staleRun).toMatchObject({ reviewed: 1 });

    expect(staleRespond).not.toHaveBeenCalled();
    expect(await heldRepliesOf(conversationId)).toEqual([
      expect.objectContaining({ state: "pending", review_ref: `email:${conversationId}:1`, draft_text: "From the claim that took over." }),
    ]);
    expect(await reviewLink(conversationId)).toMatchObject({ review_revision: 1, review_completed_revision: 1, review_due_at: null });
    expect(stalled.logger.messages()).toContain("email_review_claim_lost");
  }, 60_000);

  it("queues no send from a claim stalled in its completeness check after the claim that took over set R aside (research B17)", async () => {
    const seeded = await seedSupportMailbox(database, { engagementMode: "auto", withAgent: true });
    const target = { mailbox: seeded.mailbox, domain: seeded.domain.domain };
    await receiveAndIngest(workerNode(undefined, undefined, AUTO), FIRST, target);
    const [conversationId] = await conversationsOfMailbox(database, target.mailbox);
    await makeReviewsDue(conversationId);

    // The stalled claim's draft passes every gate and waits in the completeness check.
    let reachCheck = (): void => undefined;
    let finishCheck = (): void => undefined;
    const checkReached = new Promise<void>((resolve) => {
      reachCheck = resolve;
    });
    const checkFinished = new Promise<void>((resolve) => {
      finishCheck = resolve;
    });
    const stalledChecks: EmailReviewChecks = {
      replyTriage: { assess: async () => "yes" },
      replyCompleteness: {
        assess: async () => {
          reachCheck();
          await checkFinished;
          return { completeness: "complete", unansweredAsks: 0 };
        },
      },
    };
    const stalled = workerNode(async (input) => draft(input, "From the stalled claim."), stalledChecks, AUTO);
    const staleRun = stalled.worker.drain({ maxJobs: 5, stage: "review" });
    await checkReached;

    // Its lease runs out; another worker claims R, finds the mail needs no reply, and completes R with the note.
    await expireReviewLease(conversationId);
    const takeover = workerNode(undefined, noReplyNeeded, AUTO);
    expect(await takeover.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });
    expect(await reviewLink(conversationId)).toMatchObject({ review_revision: 1, review_completed_revision: 1 });

    finishCheck();
    expect(await staleRun).toMatchObject({ reviewed: 1 });

    expect(await heldRepliesOf(conversationId)).toEqual([]);
    expect(await outboxActionsOf(database, conversationId)).toEqual([]);
    expect(await setAsideNotesOf(conversationId)).toHaveLength(1);
    expect(await database.queryOne<{ auto_sends_since_renewal: number }>(
      "SELECT auto_sends_since_renewal FROM email_thread_links WHERE conversation_id = $1",
      [conversationId],
    )).toEqual({ auto_sends_since_renewal: 0 });
    expect(stalled.logger.messages()).toContain("email_review_claim_lost");
  }, 60_000);

  it("notes and completes a set-aside revision together: a crash between them leaves neither, and the retry leaves one note", async () => {
    const target = await draftMailbox();
    const intake = workerNode();
    await receiveAndIngest(intake, FIRST, target);
    const [conversationId] = await conversationsOfMailbox(database, target.mailbox);
    await makeReviewsDue(conversationId);

    const dying = workerNode(undefined, noReplyNeeded);
    // The note is written; the worker dies before the set-aside's transaction commits.
    dying.seams.crashAt({ seam: "activity.record", when: "after" });
    expect(await dying.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });
    expect(dying.seams.hasCrashed).toBe(true);
    expect(await setAsideNotesOf(conversationId)).toEqual([]);
    expect(await reviewLink(conversationId)).toMatchObject({ review_revision: 1, review_completed_revision: 0 });

    await expireReviewLease(conversationId);
    const recoveringRespond = vi.fn<Respond>(async (input) => draft(input, "No reply was needed."));
    const recovering = workerNode(recoveringRespond, noReplyNeeded);
    expect(await recovering.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });

    const [delivery] = await database.query<{ id: string }>("SELECT id FROM email_inbound_deliveries WHERE conversation_id = $1", [conversationId]);
    expect(await setAsideNotesOf(conversationId)).toEqual([
      expect.objectContaining({ detail: { code: "no_reply_needed", deliveryId: delivery.id } }),
    ]);
    expect(await reviewLink(conversationId)).toMatchObject({ review_revision: 1, review_completed_revision: 1, review_due_at: null });
    // R is done: no claim reviews it again, so no reply is ever held for it.
    expect(await recovering.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 0 });
    expect(recoveringRespond).not.toHaveBeenCalled();
    expect(await heldRepliesOf(conversationId)).toEqual([]);
  }, 60_000);
});
