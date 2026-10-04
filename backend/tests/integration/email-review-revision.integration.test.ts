import type { ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import type { Database } from "../../src/shared/infra/database.js";
import {
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
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Research B17 against Postgres: a review completes only its own revision, so a worker overtaken by
// newer mail leaves the newer review due and holds its own draft superseded; and a worker that dies
// after holding a draft and before completing leaves the review ref behind, so the next claim
// completes without running the model again.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const FIRST = "mime/first-contact.eml";
const FOLLOW_UP = "mime/pre-reply-follow-up.eml";
const DRAFTING = ["operator_only", "draft"] as const;

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

  const workerNode = (respond?: Respond): WorkerNode => {
    const node = createWorkerNode(suite.url, { spoolDir: spool.dir, supportedModes: DRAFTING, respond });
    nodes.push(node);
    return node;
  };

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
});
