import { randomUUID } from "node:crypto";

import type { ConnectorRespondInput, ConnectorTurnResult } from "@radioso/connector-api";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { EmailInboundRepository, EmailMailboxRepository, EventLogReader } from "../../src/modules/emailChannel/public.js";
import type { Database } from "../../src/shared/infra/database.js";
import {
  conversationsOfMailbox,
  createEmailChannelDatabase,
  createSpool,
  createWorkerNode,
  postReceived,
  relayAddressOf,
  seedSupportMailbox,
  type SeededMailbox,
} from "./support/emailChannelHarness.js";
import { counterValue } from "./support/emailSendHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// SC-006, the generation half (FR-023, AS5.5): a flood of unique first-contact mail on a `draft`
// mailbox stops generating at the mailbox's hourly budget. Half the flood reaches the worker before
// any review runs, so the budget is met at review time; the other half arrives once it is spent, so
// it is met at ingest. Either way the rest become human-owned `generation_budget` conversations,
// and every message is in the inbox and the event log.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const DRAFTING = ["operator_only", "draft"] as const;
const FLOOD = 200;
const HALF = FLOOD / 2;

type WorkerNode = ReturnType<typeof createWorkerNode>;

/** A first contact from its own sender, with its own Message-ID and no thread headers. */
const uniqueFirstContact = (index: number, domain: string): Buffer =>
  Buffer.from([
    `Message-ID: <flood-${index}-${randomUUID()}@example.test>`,
    `From: Customer ${index} <customer-${index}@example.test>`,
    `To: support@${domain}`,
    `Subject: Question ${index}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Hello, this is question ${index}.`,
    "",
  ].join("\r\n"));

const drafted = (input: ConnectorRespondInput): ConnectorTurnResult => ({
  kind: "draft",
  conversationId: input.conversationId,
  ownershipVersion: 0,
  facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false }, suppressedEffects: [], citationCount: 1 },
  draft: { text: "Thanks, we are on it.", presentation: { citations: [] } },
});

describeIntegration("email channel flood (Postgres, SC-006)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let database: Database;
  let spool: Awaited<ReturnType<typeof createSpool>>;
  const nodes: WorkerNode[] = [];

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "flood");
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

  /** Brings every review the mailbox has scheduled due by the database's clock. */
  const makeReviewsDue = (mailbox: SeededMailbox) =>
    database.execute("UPDATE email_thread_links SET review_due_at = now() - interval '1 second' WHERE mailbox_id = $1 AND review_due_at IS NOT NULL", [
      mailbox.id,
    ]);

  it("stops generating at the mailbox budget under 200 unique first contacts, hands the rest to a person, and loses nothing", async () => {
    const turns: ConnectorRespondInput[] = [];
    const node = createWorkerNode(suite.url, {
      spoolDir: spool.dir,
      supportedModes: DRAFTING,
      respond: async (input) => {
        turns.push(input);
        return drafted(input);
      },
    });
    nodes.push(node);
    const { workspaceId, mailbox, domain } = await seedSupportMailbox(database, { engagementMode: "draft", withAgent: true });
    const budget = mailbox.hourlyGenerationBudget;
    const webhook = await node.webhook();

    const emailIds: string[] = [];
    for (let index = 0; index < FLOOD; index += 1) {
      const emailId = await spool.put(uniqueFirstContact(index, domain.domain));
      expect(await postReceived(webhook, { emailId, receivedFor: [relayAddressOf(mailbox)] })).toBe(200);
      emailIds.push(emailId);
    }
    const accepted = await database.queryOne<{ events: number; seconds: number }>(
      `SELECT count(*)::int AS events, extract(epoch FROM max(received_at) - min(received_at))::float AS seconds
         FROM email_inbound_events WHERE provider_object_id = ANY($1)`,
      [emailIds],
    );
    expect(accepted.events).toBe(FLOOD);
    expect(accepted.seconds).toBeLessThan(60);

    // Half the flood is ingested and reviewed: the budget stops generation at review time.
    expect(await node.worker.drain({ maxJobs: HALF, stage: "inbound" })).toMatchObject({ processed: HALF, errored: 0, failed: 0 });
    await makeReviewsDue(mailbox);
    expect(await node.worker.drain({ maxJobs: FLOOD, stage: "review" })).toMatchObject({ reviewed: HALF });
    // The other half arrives with the budget spent: it goes to a person at ingest, and no review is scheduled.
    expect(await node.worker.drain({ maxJobs: HALF, stage: "inbound" })).toMatchObject({ processed: HALF, errored: 0, failed: 0 });
    await makeReviewsDue(mailbox);
    expect(await node.worker.drain({ maxJobs: FLOOD, stage: "review" })).toMatchObject({ reviewed: 0 });

    // Generation stopped at the budget.
    expect(turns).toHaveLength(budget);
    expect(await database.queryOne("SELECT generation_window_count FROM email_mailboxes WHERE id = $1", [mailbox.id]))
      .toEqual({ generation_window_count: budget });

    // Nothing lost: every message is in its own conversation, and every delivery is done.
    const conversations = await conversationsOfMailbox(database, mailbox);
    expect(conversations).toHaveLength(FLOOD);
    const messages = await database.query<{ conversation_id: string; role: string }>(
      "SELECT conversation_id, role FROM messages WHERE conversation_id = ANY($1)",
      [conversations],
    );
    expect(messages).toHaveLength(FLOOD);
    expect(new Set(messages.map((message) => message.conversation_id)).size).toBe(FLOOD);
    expect(messages.every((message) => message.role === "user")).toBe(true);
    const deliveries = await database.query<{ state: string; disposition: string; disposition_reason: string }>(
      "SELECT state, disposition, disposition_reason FROM email_inbound_deliveries WHERE mailbox_id = $1",
      [mailbox.id],
    );
    expect(deliveries).toHaveLength(FLOOD);
    expect(deliveries.every((delivery) => delivery.state === "done")).toBe(true);
    expect(deliveries.filter((delivery) => delivery.disposition === "run_review_turn")).toHaveLength(HALF);
    expect(deliveries.filter((delivery) => delivery.disposition === "ingest_only" && delivery.disposition_reason === "generation_budget"))
      .toHaveLength(HALF);

    // Each conversation either holds the draft its generation made, or is a person's with generation_budget.
    const draftedIds = (await database.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM held_replies WHERE conversation_id = ANY($1) AND state = 'pending'",
      [conversations],
    )).map((row) => row.conversation_id);
    const handedOffIds = (await database.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM conversation_ownership WHERE conversation_id = ANY($1) AND state = 'human_owned' AND reason = 'generation_budget'",
      [conversations],
    )).map((row) => row.conversation_id);
    expect(draftedIds).toHaveLength(budget);
    expect(handedOffIds).toHaveLength(FLOOD - budget);
    expect(new Set([...draftedIds, ...handedOffIds]).size).toBe(FLOOD);
    expect(draftedIds.sort()).toEqual(turns.map((turn) => turn.conversationId).sort());
    expect(counterValue(node.metrics, "email_budget_hits_total", { budget: "mailbox_generation" })).toBe(FLOOD - budget);

    // And the mailbox's event log accounts for every one of them.
    const eventLog = new EventLogReader({
      mailboxes: new EmailMailboxRepository(database.kysely),
      deliveries: new EmailInboundRepository(database.kysely),
      clock: () => new Date(),
    });
    expect(await eventLog.summarize(workspaceId, mailbox.id, 24)).toMatchObject({
      byDisposition: { run_review_turn: HALF, ingest_only: HALF },
      failed: 0,
    });
  }, 180_000);
});
