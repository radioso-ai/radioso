import { randomUUID } from "node:crypto";

import type { ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { EmailMailboxRepository, EmailThreadRepository } from "../../src/modules/emailChannel/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { createEmailChannelDatabase, createSpool, createWorkerNode, opaqueToken, seedSupportMailbox } from "./support/emailChannelHarness.js";
import { openEmailConversation } from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// The mailbox generation budget against Postgres (FR-023, research B8): a reservation locks the
// mailbox before the thread, as a publication does, so concurrent reviews on two replicas never
// charge past the budget and never deadlock with a publication; the window is a fixed hour anchored
// at its first generation, read on the caller's clock; a conversation revision is charged once,
// however many attempts or workers ask for it; and a charge is made only under the review's claim.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const DRAFTING = ["operator_only", "draft"] as const;
const MINUTE_MS = 60_000;

interface GenerationWindow {
  generation_window_started_at: Date | null;
  generation_window_count: number;
}

describeIntegration("email channel generation budget (Postgres, research B8)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Awaited<ReturnType<typeof createSpool>>;
  const pools: { close(): Promise<void> }[] = [];

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "budgets");
    database = suite.database;
    spool = await createSpool();
  }, 60_000);

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await spool?.remove();
    await suite?.close();
  }, 30_000);

  /** A draft mailbox whose hourly generation budget is `budget`, and `threads` email conversations linked to it. */
  const mailboxWithThreads = async (budget: number, threads: number) => {
    const { workspaceId, mailbox } = await seedSupportMailbox(database, { engagementMode: "draft", withAgent: true });
    await new EmailMailboxRepository(database.kysely).updateSettings(workspaceId, mailbox.id, { hourlyGenerationBudget: budget });
    const links = new EmailThreadRepository(database.kysely);
    const conversationIds: string[] = [];
    for (let thread = 0; thread < threads; thread += 1) {
      const conversationId = randomUUID();
      await database.execute("INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'email')", [conversationId, workspaceId]);
      await links.upsertLink({
        conversationId,
        workspaceId,
        mailboxId: mailbox.id,
        threadKey: randomUUID(),
        threadToken: opaqueToken(),
        participantAddress: `customer-${thread}@example.test`,
      });
      conversationIds.push(conversationId);
    }
    return { mailbox, conversationIds };
  };

  /** A process with its own pool, as a second worker replica would have. */
  const replica = (): EmailMailboxRepository => {
    const pool = new Database(suite.url, { poolMax: 10 });
    pools.push(pool);
    return new EmailMailboxRepository(pool.kysely);
  };

  /** Claims the thread's review as a review worker does: the claim count and the lease every charge is fenced on. */
  const claimReview = async (conversationId: string): Promise<{ attempt: number; leaseUntil: Date }> => {
    const row = await database.queryOne<{ review_attempts: number; review_lease_until: Date }>(
      `UPDATE email_thread_links
          SET review_attempts = review_attempts + 1,
              review_lease_until = date_trunc('milliseconds', now() + interval '5 minutes')
        WHERE conversation_id = $1
        RETURNING review_attempts, review_lease_until`,
      [conversationId],
    );
    return { attempt: row.review_attempts, leaseUntil: row.review_lease_until };
  };

  /** Waits until `count` sessions of the suite's database wait on a row lock; fails rather than hangs. */
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

  const windowOf = (mailboxId: string) =>
    database.queryOne<GenerationWindow>(
      "SELECT generation_window_started_at, generation_window_count FROM email_mailboxes WHERE id = $1",
      [mailboxId],
    );

  const chargedThreadsOf = async (mailboxId: string, revision: number): Promise<string[]> =>
    (await database.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM email_thread_links WHERE mailbox_id = $1 AND generation_reserved_revision = $2 ORDER BY conversation_id",
      [mailboxId, revision],
    )).map((row) => row.conversation_id);

  it("never charges past the budget under 20 concurrent reservations from two replicas", async () => {
    for (let trial = 0; trial < 3; trial += 1) {
      const { mailbox, conversationIds } = await mailboxWithThreads(5, 20);
      const claims = await Promise.all(conversationIds.map((conversationId) => claimReview(conversationId)));
      const replicas = [replica(), replica()];
      const at = new Date();

      const outcomes = await Promise.all(conversationIds.map((conversationId, index) =>
        replicas[index % replicas.length].reserveGeneration({ mailboxId: mailbox.id, conversationId, claim: claims[index], revision: 1, at })));

      expect(outcomes.filter((outcome) => outcome === "reserved")).toHaveLength(5);
      expect(outcomes.filter((outcome) => outcome === "exhausted")).toHaveLength(15);
      expect(await windowOf(mailbox.id)).toEqual({ generation_window_started_at: at, generation_window_count: 5 });
      // The threads marked charged are exactly the ones whose reservation went through.
      expect(await chargedThreadsOf(mailbox.id, 1)).toEqual(conversationIds.filter((_, index) => outcomes[index] === "reserved").sort());
      await Promise.all(pools.splice(0).map((pool) => pool.close()));
    }
  }, 60_000);

  it("rolls the window an hour after its first generation, on the caller's clock, not an hour after its latest", async () => {
    const { mailbox, conversationIds } = await mailboxWithThreads(2, 5);
    const [first, second, third, fourth, fifth] = conversationIds;
    const claims = new Map(await Promise.all(conversationIds.map(async (id) => [id, await claimReview(id)] as const)));
    const mailboxes = new EmailMailboxRepository(database.kysely);
    const opened = new Date("2026-10-04T09:00:00.000Z");
    const minutesIn = (minutes: number) => new Date(opened.getTime() + minutes * MINUTE_MS);
    const reserve = (conversationId: string, minutes: number) =>
      mailboxes.reserveGeneration({ mailboxId: mailbox.id, conversationId, claim: claims.get(conversationId)!, revision: 1, at: minutesIn(minutes) });

    expect(await reserve(first, 0)).toBe("reserved");
    expect(await reserve(second, 30)).toBe("reserved");
    expect(await reserve(third, 59)).toBe("exhausted");
    expect(await windowOf(mailbox.id)).toEqual({ generation_window_started_at: minutesIn(0), generation_window_count: 2 });

    // An hour after the first generation the window rolls; the next generation anchors the new one.
    expect(await reserve(third, 60)).toBe("reserved");
    expect(await windowOf(mailbox.id)).toEqual({ generation_window_started_at: minutesIn(60), generation_window_count: 1 });
    expect(await reserve(fourth, 90)).toBe("reserved");
    expect(await reserve(fifth, 119)).toBe("exhausted");
    expect(await reserve(fifth, 120)).toBe("reserved");
    expect(await windowOf(mailbox.id)).toEqual({ generation_window_started_at: minutesIn(120), generation_window_count: 1 });
  });

  it("charges a conversation revision once across retries and concurrent attempts, and its next revision again", async () => {
    const { mailbox, conversationIds } = await mailboxWithThreads(10, 1);
    const [conversationId] = conversationIds;
    const claim = await claimReview(conversationId);
    const mailboxes = replica();
    const at = new Date();
    const reserve = (revision: number) => mailboxes.reserveGeneration({ mailboxId: mailbox.id, conversationId, claim, revision, at });

    const concurrent = await Promise.all(Array.from({ length: 5 }, () => reserve(1)));
    expect([...concurrent].sort()).toEqual(["already_reserved", "already_reserved", "already_reserved", "already_reserved", "reserved"]);
    expect(await reserve(1)).toBe("already_reserved");
    expect((await windowOf(mailbox.id)).generation_window_count).toBe(1);

    expect(await reserve(2)).toBe("reserved");
    expect(await reserve(2)).toBe("already_reserved");
    expect((await windowOf(mailbox.id)).generation_window_count).toBe(2);
    expect(await chargedThreadsOf(mailbox.id, 2)).toEqual([conversationId]);
  });

  it("charges nothing under a claim another worker took over, and never charges an older revision again", async () => {
    const { mailbox, conversationIds } = await mailboxWithThreads(10, 1);
    const [conversationId] = conversationIds;
    const mailboxes = replica();
    const at = new Date();
    const stale = await claimReview(conversationId);
    expect(await mailboxes.reserveGeneration({ mailboxId: mailbox.id, conversationId, claim: stale, revision: 1, at })).toBe("reserved");

    // The stale claim's lease runs out; another worker claims the thread's newer revision and charges it.
    const current = await claimReview(conversationId);
    expect(await mailboxes.reserveGeneration({ mailboxId: mailbox.id, conversationId, claim: current, revision: 2, at })).toBe("reserved");

    // The stale worker resumes: it charges nothing, and R+1's charge stands.
    expect(await mailboxes.reserveGeneration({ mailboxId: mailbox.id, conversationId, claim: stale, revision: 1, at })).toBe("claim_lost");
    expect(await mailboxes.reserveGeneration({ mailboxId: mailbox.id, conversationId, claim: stale, revision: 2, at })).toBe("claim_lost");
    // Even under the current claim, an older revision is never charged again.
    expect(await mailboxes.reserveGeneration({ mailboxId: mailbox.id, conversationId, claim: current, revision: 1, at })).toBe("already_reserved");
    expect((await windowOf(mailbox.id)).generation_window_count).toBe(2);
    expect(await chargedThreadsOf(mailbox.id, 2)).toEqual([conversationId]);
  });

  it("locks the mailbox before the thread, as a publication does: a charge waiting on the mailbox holds no thread lock", async () => {
    const { mailbox, conversationIds } = await mailboxWithThreads(10, 1);
    const [conversationId] = conversationIds;
    const claim = await claimReview(conversationId);
    const publication = new Database(suite.url, { poolMax: 2 });
    pools.push(publication);
    let charging: Promise<unknown> | undefined;

    // A publication holds the mailbox `FOR SHARE` (step 3) and is about to lock the thread.
    const threadLocked = await publication.kysely.transaction().execute(async (trx) => {
      await sql`SELECT id FROM email_mailboxes WHERE id = ${mailbox.id} FOR SHARE`.execute(trx);
      charging = replica().reserveGeneration({ mailboxId: mailbox.id, conversationId, claim, revision: 1, at: new Date() });
      const waiting = await lockWaiters(1);
      expect(waiting).toEqual([expect.stringMatching(/from "email_mailboxes"/u)]);
      // The charge waits on the mailbox and holds nothing on the thread, so the publication's own
      // thread lock is granted at once instead of meeting the charge in a deadlock.
      const locked = await sql<{ conversation_id: string }>`
        SELECT conversation_id FROM email_thread_links WHERE conversation_id = ${conversationId} FOR UPDATE NOWAIT
      `.execute(trx);
      return locked.rows.length;
    });

    expect(threadLocked).toBe(1);
    expect(await charging).toBe("reserved");
    expect((await windowOf(mailbox.id)).generation_window_count).toBe(1);
  });

  it("charges a review that fails and is retried once, through the worker", async () => {
    const turns: ConnectorRespondInput[] = [];
    const respond = async (input: ConnectorRespondInput): Promise<ConnectorTurnResult> => {
      turns.push(input);
      if (turns.length === 1) throw new Error("model timeout");
      return {
        kind: "draft",
        conversationId: input.conversationId,
        ownershipVersion: 0,
        facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false }, suppressedEffects: [], citationCount: 1 },
        draft: { text: "Your order ships on Monday.", presentation: { citations: [] } },
      };
    };
    const node = createWorkerNode(suite.url, { spoolDir: spool.dir, supportedModes: DRAFTING, respond });
    pools.push(node);
    const { mailbox, conversationId } = await openEmailConversation(database, { node, spool }, { engagementMode: "draft", withAgent: true });
    // The retry's backoff, and the coalescing window, are both brought due by the database's clock.
    const makeReviewDue = () =>
      database.execute("UPDATE email_thread_links SET review_due_at = now() - interval '1 second' WHERE conversation_id = $1 AND review_due_at IS NOT NULL", [conversationId]);

    await makeReviewDue();
    expect(await node.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });
    await makeReviewDue();
    expect(await node.worker.drain({ maxJobs: 5, stage: "review" })).toMatchObject({ reviewed: 1 });

    expect(turns).toHaveLength(2);
    expect((await windowOf(mailbox.id)).generation_window_count).toBe(1);
    expect(await chargedThreadsOf(mailbox.id, 1)).toEqual([conversationId]);
    expect(await database.query("SELECT state FROM held_replies WHERE conversation_id = $1", [conversationId])).toEqual([{ state: "pending" }]);
  }, 60_000);
});
