import { randomUUID } from "node:crypto";

import type { ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { EmailMailboxRepository, EmailThreadRepository } from "../../src/modules/emailChannel/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { createEmailChannelDatabase, createSpool, createWorkerNode, opaqueToken, seedSupportMailbox } from "./support/emailChannelHarness.js";
import { openEmailConversation } from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// The mailbox generation budget against Postgres (FR-023, research B8): a reservation is one
// conditional statement, so concurrent reviews on two replicas never charge past the budget; the
// window is a fixed hour anchored at its first generation, read on the caller's clock; and a
// conversation revision is charged once, however many attempts or workers ask for it.

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
      const replicas = [replica(), replica()];
      const at = new Date();

      const outcomes = await Promise.all(conversationIds.map((conversationId, index) =>
        replicas[index % replicas.length].reserveGeneration({ mailboxId: mailbox.id, conversationId, revision: 1, at })));

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
    const mailboxes = new EmailMailboxRepository(database.kysely);
    const opened = new Date("2026-10-04T09:00:00.000Z");
    const minutesIn = (minutes: number) => new Date(opened.getTime() + minutes * MINUTE_MS);
    const reserve = (conversationId: string, minutes: number) =>
      mailboxes.reserveGeneration({ mailboxId: mailbox.id, conversationId, revision: 1, at: minutesIn(minutes) });

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
    const mailboxes = replica();
    const at = new Date();
    const reserve = (revision: number) => mailboxes.reserveGeneration({ mailboxId: mailbox.id, conversationId, revision, at });

    const concurrent = await Promise.all(Array.from({ length: 5 }, () => reserve(1)));
    expect([...concurrent].sort()).toEqual(["already_reserved", "already_reserved", "already_reserved", "already_reserved", "reserved"]);
    expect(await reserve(1)).toBe("already_reserved");
    expect((await windowOf(mailbox.id)).generation_window_count).toBe(1);

    expect(await reserve(2)).toBe("reserved");
    expect(await reserve(2)).toBe("already_reserved");
    expect((await windowOf(mailbox.id)).generation_window_count).toBe(2);
    expect(await chargedThreadsOf(mailbox.id, 2)).toEqual([conversationId]);
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
