import { afterAll, beforeAll, expect, it } from "vitest";

import {
  defaultConversationDataErasers,
  defaultVerifiedCustomerDataErasers,
  defaultVisitorKeyDataErasers,
} from "../../src/app/composition/conversationErasure.js";
import { Database } from "../../src/shared/infra/database.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/**
 * How a column that names a conversation, a chat session, a visitor or a message is erased when
 * its foreign key does not cascade. A cascading key needs no entry; every other such column does,
 * so a table added with an unconstrained `conversation_id` fails here until it gets a cascading
 * key, an eraser in `app/composition/conversationErasure.ts`, or a stated reason.
 */
type ErasureCoverage =
  /** The row goes with a sibling column whose key cascades. */
  | { kind: "row_cascades_with"; column: string; reason?: string }
  /** A module's eraser removes the row; the owner must be registered. */
  | { kind: "eraser"; owner: string; reason: string }
  /** The row stays on purpose and holds nothing from the conversation. */
  | { kind: "retained"; reason: string; edition?: "ee" }
  /** The column names something other than a stored conversation. */
  | { kind: "not_a_conversation"; reason: string }
  /** The erased subject's own row, which the erasure deletes. */
  | { kind: "subject"; reason: string };

const coverage: Record<string, ErasureCoverage> = {
  "conversations.anonymous_session_id": { kind: "subject", reason: "The conversation's own row." },
  "conversations.visitor_id": {
    kind: "subject",
    reason: "A visitor's erasure deletes their conversations before the visitor row, so the SET NULL never strands one.",
  },
  "answer_coverage_assessments.assistant_message_id": { kind: "row_cascades_with", column: "conversation_id" },
  "assistant_answer_feedback.anonymous_session_id": { kind: "row_cascades_with", column: "conversation_id" },
  "email_inbound_deliveries.rfc_message_id": { kind: "row_cascades_with", column: "conversation_id", reason: "The mail's own Message-Id." },
  "email_send_intents.provider_message_id": { kind: "row_cascades_with", column: "conversation_id", reason: "The provider's id for the send." },
  "email_send_intents.supplied_rfc_message_id": { kind: "row_cascades_with", column: "conversation_id", reason: "The send's Message-Id." },
  "email_send_intents.delivered_rfc_message_id": { kind: "row_cascades_with", column: "conversation_id", reason: "The send's Message-Id as delivered." },
  "email_thread_messages.rfc_message_id": { kind: "row_cascades_with", column: "conversation_id", reason: "The mail's own Message-Id." },
  "email_inbound_deliveries.message_id": { kind: "row_cascades_with", column: "conversation_id" },
  "eval_snapshots.source_message_id": { kind: "row_cascades_with", column: "source_conversation_id" },
  "held_replies.released_message_id": { kind: "row_cascades_with", column: "conversation_id" },
  "routine_states.started_message_id": { kind: "row_cascades_with", column: "session_id", reason: "The visitor message that started the current routine execution, in the same conversation." },
  "voice_sessions.conversation_id": {
    kind: "eraser",
    owner: "voice-channel",
    reason: "The link is SET NULL so a conversation deleted any other way leaves where its call's recording is; an erasure reads the recording first and the voice eraser removes the row.",
  },
  "voice_sessions.vendor_conversation_id": {
    kind: "eraser",
    owner: "voice-channel",
    reason: "The voice vendor's id for the call, which names its recording there; the erasure asks the vendor to delete the recording, and the voice eraser removes the row.",
  },
  "voice_sessions.started_public_session_id": {
    kind: "eraser",
    owner: "voice-channel",
    reason: "The website visitor's public session that started the call, beside their visitor key (started_visitor_key, which this query does not match). The voice eraser removes the row with its conversation, or, for a call no turn ever bound, with the erased visitor's key; a start whose page reported no recording also goes at the agent's next start.",
  },
  "email_inbound_deliveries.planned_conversation_id": {
    kind: "eraser",
    owner: "email-channel",
    reason: "Ingest reserves a conversation id before the conversation exists, so no key can hold it.",
  },
  "email_inbound_deliveries.planned_message_id": {
    kind: "eraser",
    owner: "email-channel",
    reason: "Reserved with planned_conversation_id; the same eraser removes the row.",
  },
  "email_skill_activity.provider_message_id": {
    kind: "eraser",
    owner: "customer-email",
    reason: "The provider's id for the sent email; the row goes with its conversation_id.",
  },
  "email_skill_activity.conversation_id": {
    kind: "eraser",
    owner: "customer-email",
    reason: "A private test can send a real email from a conversation that never becomes a conversations row.",
  },
  "usage_events.conversation_id": { kind: "retained", reason: "The billing ledger keeps its rows and loses the link (SET NULL)." },
  "usage_events.message_id": { kind: "retained", reason: "The billing ledger keeps its rows and loses the link (SET NULL)." },
  "notification_delivery_outcomes.conversation_id": {
    kind: "retained",
    reason: "The daily email cap's ledger: counts and a recipient digest only. Erasing a conversation must not return its emails to the day's budget (SET NULL).",
  },
  "ee_usage_limit_conversation_replies.conversation_id": {
    kind: "retained",
    edition: "ee",
    reason: "The Enterprise Edition's reply quota counter holds an id and a count. Erasing conversations must not reset a tenant's quota.",
  },
  "agent_test_execution_sides.conversation_id": {
    kind: "not_a_conversation",
    reason: "A private test side mints a conversation id that never becomes a conversations row; its transcript belongs to the test execution.",
  },
  "copilot_messages.conversation_id": {
    kind: "not_a_conversation",
    reason: "Ray's own conversation, which cascades from copilot_conversations and goes with Ray's retention.",
  },
  "copilot_proposals.conversation_id": {
    kind: "not_a_conversation",
    reason: "The Ray conversation that drafted the proposal.",
  },
  "copilot_proposals.message_id": {
    kind: "not_a_conversation",
    reason: "The Ray message that drafted the proposal.",
  },
  "copilot_replay_evidence.conversation_id": {
    kind: "not_a_conversation",
    reason: "The Ray conversation that ran the replay.",
  },
  "operator_mcp_authorization_transactions.session_id": {
    kind: "not_a_conversation",
    reason: "A teammate's dashboard sign-in session.",
  },
  "agent_converse_session_mappings.public_session_id": {
    kind: "not_a_conversation",
    reason: "Maps an agent grant to the public session it minted; it holds no conversation content.",
  },
};

/**
 * Keys that would hold back a conversation's cascade (`ON DELETE RESTRICT` or `NO ACTION` on a row
 * the cascade reaches), each with the eraser that clears the holding rows first. An unlisted one makes
 * every erasure of an affected conversation fail.
 */
const cascadeHolds: Record<string, string> = {
  eval_cases_snapshot_id_fkey: "eval",
  eval_runs_snapshot_id_fkey: "eval",
};

interface ColumnRow {
  table_name: string;
  column_name: string;
  cascading_parents: string[] | null;
}

/** The tables an erasure deletes. Only a key to one of them cascades erased data away. */
const SUBJECT_TABLES = ["conversations", "messages", "visitors"] as const;

describeIntegration("conversation erasure schema coverage", () => {
  const database = new Database(integrationDatabaseUrl);
  let columns: Map<string, { cascadingParents: string[] }>;

  beforeAll(async () => {
    await runAllTestMigrations(database);
    // Every column named like a conversation, chat session, visitor or message reference, whatever its
    // type, with the subject tables its foreign keys cascade from.
    const rows = await database.query<ColumnRow>(`
      SELECT c.table_name, c.column_name,
             array_agg(k.confrelid::regclass::text) FILTER (
               WHERE k.oid IS NOT NULL AND k.confdeltype = 'c' AND k.confrelid::regclass::text = ANY ($1::text[])
             ) AS cascading_parents
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        LEFT JOIN pg_attribute a
          ON a.attrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
         AND a.attname = c.column_name
        LEFT JOIN pg_constraint k
          ON k.conrelid = a.attrelid AND k.contype = 'f' AND a.attnum = ANY (k.conkey)
       WHERE c.table_schema = 'public'
         AND c.column_name ~ '(^|_)(conversation|session|visitor|message)_id$'
       GROUP BY c.table_name, c.column_name`, [[...SUBJECT_TABLES]]);
    columns = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, { cascadingParents: row.cascading_parents ?? [] }]));
  });

  afterAll(async () => {
    await database.close().catch(() => undefined);
  });

  /** Whether a key on the column cascades from a table an erasure deletes. */
  const cascades = (key: string): boolean => (columns.get(key)?.cascadingParents.length ?? 0) > 0;
  const registeredOwners = (): Set<string> => {
    // Erasers only hold the transaction they are bound to, so binding one to nothing reads its owner.
    const unbound = {} as Db;
    return new Set([
      ...defaultConversationDataErasers.map((bind) => bind(unbound).owner),
      ...defaultVerifiedCustomerDataErasers.map((bind) => bind(unbound).owner),
      ...defaultVisitorKeyDataErasers.map((bind) => bind(unbound).owner),
    ]);
  };

  it("finds the conversation references it is meant to police, text-typed ones included", () => {
    expect(columns.has("messages.conversation_id")).toBe(true);
    expect(columns.has("routine_states.session_id")).toBe(true);
    expect(columns.has("conversations.anonymous_session_id")).toBe(true);
    expect(columns.has("email_thread_messages.rfc_message_id")).toBe(true);
    expect(columns.size).toBeGreaterThan(50);
  });

  it("counts a key as a cascade only when it cascades from a conversation, message or visitor", () => {
    // Ray's messages cascade from Ray's own conversation table, which no erasure deletes.
    expect(cascades("copilot_messages.conversation_id")).toBe(false);
    expect(cascades("messages.conversation_id")).toBe(true);
  });

  it("gives every conversation, session, visitor and message reference a cascade, an eraser, or a reason", () => {
    const uncovered = [...columns.keys()].filter((key) => !cascades(key) && !coverage[key]).sort();
    expect(uncovered).toEqual([]);
  });

  it("names only registered eraser owners", () => {
    const owners = registeredOwners();
    const unknown = Object.entries(coverage)
      .filter(([, entry]) => entry.kind === "eraser" && !owners.has(entry.owner))
      .map(([key]) => key);
    expect(unknown).toEqual([]);
  });

  it("points every row-cascades-with entry at a sibling whose key cascades", () => {
    const broken = Object.entries(coverage)
      .filter(([key, entry]) => entry.kind === "row_cascades_with" && !cascades(`${key.split(".")[0]}.${entry.column}`))
      .map(([key]) => key);
    expect(broken).toEqual([]);
  });

  it("lets nothing hold back a conversation's cascade unless a registered eraser clears it first", async () => {
    const holds = await database.query<{ constraint_name: string }>(`
      WITH RECURSIVE reached(tbl) AS (
        SELECT 'conversations'::regclass
        UNION
        SELECT k.conrelid FROM pg_constraint k JOIN reached r ON k.confrelid = r.tbl
         WHERE k.contype = 'f' AND k.confdeltype = 'c'
      )
      SELECT k.conname AS constraint_name
        FROM pg_constraint k JOIN reached r ON k.confrelid = r.tbl
       WHERE k.contype = 'f' AND k.confdeltype IN ('r', 'a')
       ORDER BY 1`);
    const owners = registeredOwners();
    const unhandled = holds
      .map((hold) => hold.constraint_name)
      .filter((name) => !cascadeHolds[name] || !owners.has(cascadeHolds[name]));
    expect(unhandled).toEqual([]);
  });

  it("carries no entry for a column that is gone or already cascades", () => {
    const stale = Object.entries(coverage)
      .filter(([, entry]) => !(entry.kind === "retained" && entry.edition === "ee"))
      .filter(([key]) => !columns.has(key) || cascades(key))
      .map(([key]) => key);
    expect(stale).toEqual([]);
  });
});
