import { afterAll, beforeAll, expect, it } from "vitest";

import { defaultDataSubjectDataExporters } from "../../src/app/composition/dataSubjectAccess.js";
import { Database } from "../../src/shared/infra/database.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/**
 * Where a table that holds data about a conversation, a chat session, a visitor or a message, or
 * that is keyed by a person's identifier (a verified customer id, a visitor key, an address), goes
 * in a data subject's export. Every such table needs an entry, so a table added with a
 * `conversation_id` or a `sender_address` fails here until it gets a section in
 * `app/composition/dataSubjectAccess.ts` or a stated reason it stays out.
 */
type ExportCoverage =
  /** A registered exporter writes the table's rows to this section. */
  | { kind: "exported"; section: string }
  /** The table holds nothing about the subject an export would carry. */
  | { kind: "excluded"; reason: string; edition?: "ee" };

const excluded = (reason: string): ExportCoverage => ({ kind: "excluded", reason });

const coverage: Record<string, ExportCoverage> = {
  conversations: { kind: "exported", section: "conversations" },
  messages: { kind: "exported", section: "conversations" },
  visitors: { kind: "exported", section: "visitors" },
  routine_states: { kind: "exported", section: "routine_values" },
  routine_action_requests: { kind: "exported", section: "routine_actions" },
  conversation_summaries: { kind: "exported", section: "conversation_summaries" },
  context_variable_values: { kind: "exported", section: "context_values" },
  email_thread_messages: { kind: "exported", section: "email_messages" },
  email_inbound_deliveries: { kind: "exported", section: "email_messages" },
  assistant_answer_feedback: { kind: "exported", section: "answer_feedback" },

  email_mailboxes: excluded("The workspace's own mailbox and its address, not anyone who wrote to it."),
  email_thread_links: excluded("How the email finder finds a sender's threads. Its latest subject, Cc and display name copy what email_messages carries for each mail."),
  slack_conversation_links: excluded("How the Slack finder finds a member's threads: a routing key naming the Slack workspace, channel and thread, which the conversation's channel context carries too."),
  email_send_intents: excluded("Delivery bookkeeping for replies the export carries as messages: provider ids, states and the authority to send."),
  email_skill_activity: excluded("A record that an email skill sent mail: an outcome and a redacted recipient summary, never the mail."),
  connector_whatsapp_contacts: excluded("The WhatsApp channel's contact row, outside the web, email and Slack identities a lookup finds; a WhatsApp conversation is exported when another identity reaches it."),
  voice_sessions: excluded("Where a call's recording sits at the voice vendor: the vendor's ids for it. The call's transcript is the conversation's messages."),
  voice_recording_erasure_items: excluded("Bookkeeping for deleting an already erased conversation's recording at the voice vendor: the vendor's ids for it, asks, and coded outcomes, never content. It is written as the conversation is erased, so no lookup reaches it, and the organization reads what is left at the vendor in its own list."),
  conversation_ownership: excluded("Which teammate owns a conversation and since when: the workspace's own workflow, not data about the subject."),
  conversation_activity: excluded("The teammates' activity on a conversation (assignment, closing), which names teammates, not the subject."),
  conversation_delivery_failures: excluded("A reply that may not have reached the subject: provider codes and a teammate's decision, for a reply the export carries as a message."),
  held_replies: excluded("A draft awaiting a teammate's review. A released draft is exported as the message it became; one discarded never reached the subject."),
  pending_decisions: excluded("A teammate's approval of a routine step: the options the routine's author wrote and the decision, on values routine_values carries."),
  clarification_states: excluded("A clarification in progress: the subject's question again, which the export carries as a message, and the candidates offered."),
  directive_states: excluded("Which of the workspace's directives fired on which turn: rule ids and counters."),
  answer_coverage_assessments: excluded("The platform's verdict on whether the workspace's documents covered a request, beside a restatement of the question the export carries as a message."),
  answer_coverage_reaction_traces: excluded("How the agent reacted to a coverage verdict: rule ids and decisions."),
  assistant_answer_triage: excluded("A teammate's triage of an answer's quality: states and notes of the workspace's own review."),
  assistant_answer_triage_transitions: excluded("The history of a teammate's triage of an answer."),
  agent_revision_migration_classifications: excluded("Which routine a conversation was in when its agent's published revision changed: ids and a label the platform assigned."),
  message_facets: excluded("A search index entry derived from a message the export carries."),
  facet_extraction_jobs: excluded("The queue that builds message_facets: job states only."),
  topic_memberships: excluded("Audience Pulse's grouping of a message into a topic: ids and a distance."),
  eval_snapshots: excluded("A teammate's copy of a conversation, kept as an evaluation case of the agent; its messages are the conversation's, which the export carries."),
  eval_message_case_associations: excluded("Links an answer to the evaluation case a teammate made of it."),
  usage_events: excluded("The billing ledger: models, tokens and costs per turn."),
  notification_delivery_outcomes: excluded("The daily email cap's ledger: counts and a recipient digest."),
  agent_test_execution_sides: excluded("A private test side mints a conversation id that never becomes a conversations row; its transcript is a teammate's test."),
  agent_converse_session_mappings: excluded("Maps an agent grant to the public session it minted; it holds no conversation content."),
  copilot_messages: excluded("Ray's own conversation with a teammate."),
  copilot_proposals: excluded("A change Ray drafted for a teammate."),
  copilot_replay_evidence: excluded("A replay Ray ran for a teammate."),
  operator_mcp_authorization_transactions: excluded("A teammate's dashboard sign-in session."),
  skill_intake_states: excluded("Nothing writes or reads this table; a skill's inputs are collected by routines, whose values routine_values carries."),
  ee_usage_limit_conversation_replies: { kind: "excluded", edition: "ee", reason: "The Enterprise Edition's reply quota counter: an id and a count." },
};

/**
 * Tables keyed by a subject in a way no column name shows: customer-scoped context values carry the
 * verified customer id in a generic `scope_id`.
 */
const SUBJECT_KEYED_TABLES = ["context_variable_values"] as const;

/**
 * Columns that name a conversation, chat session, visitor or message, or carry a person's own
 * identifier: a verified customer id, a visitor key, an address. Matched whatever their type.
 */
const SUBJECT_COLUMN_PATTERN = "(^|_)(conversation|session|visitor|message)_id$|(^|_)(verified_customer_id|visitor_key)$|(^|_)address(es)?$";

describeIntegration("data subject export schema coverage", () => {
  const database = new Database(integrationDatabaseUrl);
  let tables: Set<string>;
  let referencingTables: Set<string>;

  beforeAll(async () => {
    await runAllTestMigrations(database);
    const all = await database.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    tables = new Set(all.map((row) => row.table_name));
    // The columns the erasure coverage polices, and those keyed by a person's identifier.
    const referencing = await database.query<{ table_name: string }>(`
      SELECT DISTINCT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
       WHERE c.table_schema = 'public'
         AND c.column_name ~ $1`, [SUBJECT_COLUMN_PATTERN]);
    referencingTables = new Set(referencing.map((row) => row.table_name));
  });

  afterAll(async () => {
    await database.close().catch(() => undefined);
  });

  const registeredSections = (): Set<string> => {
    // Exporters only hold the transaction they are bound to, so binding one to nothing reads its section.
    const unbound = {} as Db;
    return new Set(defaultDataSubjectDataExporters.map((bind) => bind(unbound).section));
  };

  it("finds the tables it is meant to police", () => {
    expect(referencingTables.has("messages")).toBe(true);
    expect(referencingTables.has("routine_states")).toBe(true);
    // Keyed by a person's identifier rather than a conversation.
    expect(referencingTables.has("visitors")).toBe(true);
    expect(referencingTables.has("email_thread_links")).toBe(true);
    expect(referencingTables.has("email_inbound_deliveries")).toBe(true);
    for (const table of SUBJECT_KEYED_TABLES) expect(tables.has(table)).toBe(true);
    expect(referencingTables.size).toBeGreaterThan(30);
  });

  it("gives every table holding conversation or visitor data a section or a reason", () => {
    const uncovered = [...referencingTables, ...SUBJECT_KEYED_TABLES].filter((table) => !coverage[table]).sort();
    expect(uncovered).toEqual([]);
  });

  it("names only sections a registered exporter writes, and every registered section", () => {
    const sections = registeredSections();
    const named = new Set(Object.values(coverage).flatMap((entry) => (entry.kind === "exported" ? [entry.section] : [])));
    expect([...named].filter((section) => !sections.has(section))).toEqual([]);
    expect([...sections].filter((section) => !named.has(section))).toEqual([]);
  });

  it("registers each section once", () => {
    const sections = defaultDataSubjectDataExporters.map((bind) => bind({} as Db).section);
    expect(sections.length).toBe(new Set(sections).size);
  });

  it("carries no entry for a table that is gone", () => {
    const stale = Object.entries(coverage)
      .filter(([, entry]) => !(entry.kind === "excluded" && entry.edition === "ee"))
      .filter(([table]) => !tables.has(table))
      .map(([table]) => table);
    expect(stale).toEqual([]);
  });
});
