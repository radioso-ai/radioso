import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { applyTestMigration, runTestMigrationsBefore } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const keystone = "209_email_channel_keystone.sql";
const inbound = "210_email_inbound_events.sql";
const activityWidening = [
  "211_conversation_activity_kind_v2_add.sql",
  "212_conversation_activity_kind_v2_validate.sql",
  "213_conversation_activity_kind_drop_v1.sql",
  "214_conversation_activity_closed_idx_v2.sql",
];
const deliveryFailures = "215_conversation_delivery_failures.sql";
const sendIntents = "216_email_send_intents.sql";
const heldReplies = "218_held_replies.sql";
const mailboxSettingsTrim = "219_email_mailboxes_drop_context_and_spam.sql";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const canReach = async (url?: string) => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const isolatedUrl = (base: string, name: string) => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

const errorCode = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("email channel schema (209–219)", () => {
  const databaseName = `mig209_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let database: Database;

  const foreignKeys = (table: string) =>
    database.query<{ column: string; target: string; on_delete: string }>(
      `SELECT a.attname AS column,
              c.confrelid::regclass::text AS target,
              c.confdeltype::text AS on_delete
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.conrelid = $1::regclass
        ORDER BY a.attname`,
      [table],
    );

  const seedWorkspace = async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig209-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Agent')", [agentId, workspaceId]);
    return { accountId, workspaceId, agentId };
  };

  const insertDomain = async (workspaceId: string, domain: string) => {
    const id = randomUUID();
    await database.execute(
      "INSERT INTO email_domains (id, workspace_id, domain, provider) VALUES ($1, $2, $3, 'resend')",
      [id, workspaceId, domain],
    );
    return id;
  };

  const insertMailbox = async (
    workspaceId: string,
    domainId: string,
    address: string,
    overrides: { agentId?: string | null; relayToken?: string } = {},
  ) => {
    const id = randomUUID();
    await database.execute(
      `INSERT INTO email_mailboxes (id, workspace_id, domain_id, agent_id, address, display_name, relay_token, engagement_mode)
       VALUES ($1, $2, $3, $4, $5, 'Support', $6, 'operator_only')`,
      [id, workspaceId, domainId, overrides.agentId ?? null, address, overrides.relayToken ?? randomUUID().slice(0, 26)],
    );
    return id;
  };

  const insertConversation = async (workspaceId: string) => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await database.execute(
      "INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'email')",
      [conversationId, workspaceId],
    );
    await database.execute(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'user', 'Hello')",
      [messageId, conversationId, workspaceId],
    );
    return { conversationId, messageId };
  };

  const insertEvent = async (providerEventId = randomUUID()) => {
    const id = randomUUID();
    await database.execute(
      `INSERT INTO email_inbound_events (id, provider, provider_event_id, event_kind, provider_object_id, envelope)
       VALUES ($1, 'resend', $2, 'message_received', $3, '{}'::jsonb)`,
      [id, providerEventId, randomUUID()],
    );
    return id;
  };

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runTestMigrationsBefore(database, keystone);
  }, 120_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("209 applies on its own, every FK pointing at a table that already exists, the index links left for later", async () => {
    await applyTestMigration(database, keystone);

    expect(await foreignKeys("email_thread_messages")).toEqual([
      { column: "conversation_id", target: "conversations", on_delete: "c" },
      { column: "mailbox_id", target: "email_mailboxes", on_delete: "r" },
      { column: "message_id", target: "messages", on_delete: "c" },
    ]);
    expect(await foreignKeys("email_mailboxes")).toEqual([
      { column: "agent_id", target: "agents", on_delete: "n" },
      { column: "domain_id", target: "email_domains", on_delete: "r" },
      { column: "workspace_id", target: "workspaces", on_delete: "c" },
    ]);
    expect(await foreignKeys("email_thread_links")).toEqual([
      { column: "conversation_id", target: "conversations", on_delete: "c" },
      { column: "mailbox_id", target: "email_mailboxes", on_delete: "r" },
    ]);
    expect(await foreignKeys("email_mailbox_policies")).toEqual([
      { column: "mailbox_id", target: "email_mailboxes", on_delete: "c" },
    ]);
  });

  it("210 creates the inbound tables and links the thread index to its delivery; the send-intent link waits for 216", async () => {
    await applyTestMigration(database, inbound);

    expect(await foreignKeys("email_thread_messages")).toContainEqual(
      { column: "inbound_delivery_id", target: "email_inbound_deliveries", on_delete: "n" },
    );
    expect((await foreignKeys("email_thread_messages")).map((fk) => fk.column)).not.toContain("send_intent_id");
    expect(await foreignKeys("email_inbound_deliveries")).toEqual([
      { column: "conversation_id", target: "conversations", on_delete: "c" },
      { column: "inbound_event_id", target: "email_inbound_events", on_delete: "c" },
      { column: "mailbox_id", target: "email_mailboxes", on_delete: "r" },
      { column: "message_id", target: "messages", on_delete: "n" },
      { column: "workspace_id", target: "workspaces", on_delete: "c" },
    ]);
  });

  it("keeps one active registration per domain, lowercase, with the documented statuses", async () => {
    const { workspaceId } = await seedWorkspace();
    const other = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "acme.example");

    expect(await errorCode(insertDomain(other.workspaceId, "acme.example"))).toBe(UNIQUE_VIOLATION);
    expect(await errorCode(insertDomain(workspaceId, "Upper.Example"))).toBe(CHECK_VIOLATION);
    expect(await errorCode(database.execute(
      "UPDATE email_domains SET sending_status = 'verifying' WHERE id = $1", [domainId],
    ))).toBe(CHECK_VIOLATION);
    expect(await errorCode(database.execute(
      "UPDATE email_domains SET provider_cleanup_status = 'later' WHERE id = $1", [domainId],
    ))).toBe(CHECK_VIOLATION);

    const defaults = await database.queryOne<{ sending_status: string; receiving_status: string; dns_records: unknown }>(
      "SELECT sending_status, receiving_status, dns_records FROM email_domains WHERE id = $1",
      [domainId],
    );
    expect(defaults).toEqual({ sending_status: "pending", receiving_status: "not_requested", dns_records: [] });

    await database.execute("UPDATE email_domains SET removed_at = now() WHERE id = $1", [domainId]);
    await insertDomain(other.workspaceId, "acme.example");
  });

  it("holds mailbox addresses and relay tokens unique, and its budgets inside their bounds", async () => {
    const { workspaceId } = await seedWorkspace();
    const other = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "mailboxes.example");
    const otherDomainId = await insertDomain(other.workspaceId, "other-mailboxes.example");
    const mailboxId = await insertMailbox(workspaceId, domainId, "support@mailboxes.example", { relayToken: "a".repeat(26) });

    expect(await errorCode(insertMailbox(other.workspaceId, otherDomainId, "support@mailboxes.example"))).toBe(UNIQUE_VIOLATION);
    expect(await errorCode(insertMailbox(workspaceId, domainId, "sales@mailboxes.example", { relayToken: "a".repeat(26) })))
      .toBe(UNIQUE_VIOLATION);
    expect(await errorCode(insertMailbox(workspaceId, domainId, "Sales@mailboxes.example"))).toBe(CHECK_VIOLATION);
    expect(await errorCode(insertMailbox(workspaceId, randomUUID(), "x@mailboxes.example"))).toBe(FOREIGN_KEY_VIOLATION);

    for (const [column, value] of [
      ["engagement_mode", "'autopilot'"],
      ["thread_send_budget", "0"],
      ["thread_send_budget", "21"],
      ["hourly_generation_budget", "1001"],
      ["thread_context_messages", "51"],
      ["silence_threshold_hours", "2161"],
      ["setup_check_step", "'dns'"],
    ] as const) {
      expect(
        await errorCode(database.execute(`UPDATE email_mailboxes SET ${column} = ${value} WHERE id = $1`, [mailboxId])),
        `${column} = ${value}`,
      ).toBe(CHECK_VIOLATION);
    }

    await database.execute("UPDATE email_mailboxes SET previous_relay_token = $2 WHERE id = $1", [mailboxId, "b".repeat(26)]);
    const sibling = await insertMailbox(workspaceId, domainId, "sales@mailboxes.example");
    expect(await errorCode(database.execute(
      "UPDATE email_mailboxes SET previous_relay_token = $2 WHERE id = $1", [sibling, "b".repeat(26)],
    ))).toBe(UNIQUE_VIOLATION);

    await database.execute("UPDATE email_mailboxes SET removed_at = now() WHERE id = $1", [mailboxId]);
    await insertMailbox(workspaceId, domainId, "support@mailboxes.example");

    const defaults = await database.queryOne<Record<string, unknown>>(
      `SELECT enabled, policy_version, thread_send_budget, hourly_generation_budget, generation_window_count,
              silence_threshold_hours
         FROM email_mailboxes WHERE id = $1`,
      [sibling],
    );
    expect(defaults).toEqual({
      enabled: true,
      policy_version: 1,
      thread_send_budget: 3,
      hourly_generation_budget: 30,
      generation_window_count: 0,
      silence_threshold_hours: 72,
    });
  });

  it("keeps policy history append-only by version", async () => {
    const { workspaceId } = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "policies.example");
    const mailboxId = await insertMailbox(workspaceId, domainId, "support@policies.example");
    const insertPolicy = (version: number, mode: string) =>
      database.execute(
        "INSERT INTO email_mailbox_policies (mailbox_id, version, engagement_mode, enabled) VALUES ($1, $2, $3, true)",
        [mailboxId, version, mode],
      );

    await insertPolicy(1, "operator_only");
    await insertPolicy(2, "draft");
    expect(await errorCode(insertPolicy(2, "auto"))).toBe(UNIQUE_VIOLATION);
    expect(await errorCode(insertPolicy(3, "unsupervised"))).toBe(CHECK_VIOLATION);
  });

  it("indexes each RFC Message-Id once per mailbox, with only the documented direction and origin pairs", async () => {
    const { workspaceId } = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "threads.example");
    const mailboxId = await insertMailbox(workspaceId, domainId, "support@threads.example");
    const otherMailboxId = await insertMailbox(workspaceId, domainId, "sales@threads.example");
    const { conversationId, messageId } = await insertConversation(workspaceId);
    const insertIndexRow = (mailbox: string, rfcMessageId: string, direction: string, origin: string) =>
      database.execute(
        `INSERT INTO email_thread_messages (workspace_id, mailbox_id, conversation_id, message_id, direction, origin, rfc_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [workspaceId, mailbox, conversationId, direction === "referenced" ? null : messageId, direction, origin, rfcMessageId],
      );

    await insertIndexRow(mailboxId, "<m1@customer.example>", "inbound", "inbound");
    await insertIndexRow(mailboxId, "<m2@customer.example>", "referenced", "referenced");
    await insertIndexRow(mailboxId, "<m3@radioso.example>", "outbound", "radioso_generated");
    await insertIndexRow(mailboxId, "<m4@provider.example>", "outbound", "provider_delivered");
    // The same Message-Id in a second mailbox is independent (B15 vii).
    await insertIndexRow(otherMailboxId, "<m1@customer.example>", "inbound", "inbound");

    expect(await errorCode(insertIndexRow(mailboxId, "<m1@customer.example>", "inbound", "inbound"))).toBe(UNIQUE_VIOLATION);
    for (const [direction, origin] of [
      ["inbound", "radioso_generated"],
      ["outbound", "inbound"],
      ["referenced", "provider_delivered"],
      ["inbound", "referenced"],
    ] as const) {
      expect(
        await errorCode(insertIndexRow(mailboxId, `<${randomUUID()}@x.example>`, direction, origin)),
        `${direction}/${origin}`,
      ).toBe(CHECK_VIOLATION);
    }

    const linkToken = randomUUID();
    const insertLink = (conversation: string, threadKey: string, threadToken: string) =>
      database.execute(
        `INSERT INTO email_thread_links (conversation_id, workspace_id, mailbox_id, thread_key, thread_token, participant_address)
         VALUES ($1, $2, $3, $4, $5, 'ana@customer.example')`,
        [conversation, workspaceId, mailboxId, threadKey, threadToken],
      );
    const threadKey = randomUUID();
    await insertLink(conversationId, threadKey, linkToken);
    const second = await insertConversation(workspaceId);
    expect(await errorCode(insertLink(second.conversationId, threadKey, randomUUID()))).toBe(UNIQUE_VIOLATION);
    expect(await errorCode(insertLink(second.conversationId, randomUUID(), linkToken))).toBe(UNIQUE_VIOLATION);
  });

  it("dedupes provider events and keeps one delivery per event and mailbox", async () => {
    const { workspaceId } = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "deliveries.example");
    const mailboxId = await insertMailbox(workspaceId, domainId, "support@deliveries.example");
    const providerEventId = randomUUID();
    const eventId = await insertEvent(providerEventId);

    expect(await errorCode(insertEvent(providerEventId))).toBe(UNIQUE_VIOLATION);
    const objectId = await database.queryOne<{ provider_object_id: string }>(
      "SELECT provider_object_id FROM email_inbound_events WHERE id = $1", [eventId],
    );
    expect(await errorCode(database.execute(
      `INSERT INTO email_inbound_events (provider, provider_event_id, event_kind, provider_object_id, envelope)
       VALUES ('resend', $1, 'message_received', $2, '{}'::jsonb)`,
      [randomUUID(), objectId.provider_object_id],
    ))).toBe(UNIQUE_VIOLATION);
    // A delivery-status event about the same object is a separate obligation.
    await database.execute(
      `INSERT INTO email_inbound_events (provider, provider_event_id, event_kind, provider_object_id, envelope)
       VALUES ('resend', $1, 'delivery_status', $2, '{}'::jsonb)`,
      [randomUUID(), objectId.provider_object_id],
    );

    const insertDelivery = (mailbox: string | null) =>
      database.execute(
        "INSERT INTO email_inbound_deliveries (inbound_event_id, workspace_id, mailbox_id) VALUES ($1, $2, $3)",
        [eventId, mailbox === null ? null : workspaceId, mailbox],
      );
    await insertDelivery(mailboxId);
    await insertDelivery(null);
    expect(await errorCode(insertDelivery(mailboxId))).toBe(UNIQUE_VIOLATION);
    expect(await errorCode(insertDelivery(null))).toBe(UNIQUE_VIOLATION);

    // The writers' idempotent insert names the documented arbiters.
    await database.execute(
      `INSERT INTO email_inbound_deliveries (inbound_event_id, workspace_id, mailbox_id) VALUES ($1, $2, $3)
       ON CONFLICT (inbound_event_id, mailbox_id) WHERE mailbox_id IS NOT NULL DO NOTHING`,
      [eventId, workspaceId, mailboxId],
    );
    await database.execute(
      `INSERT INTO email_inbound_deliveries (inbound_event_id) VALUES ($1)
       ON CONFLICT (inbound_event_id) WHERE mailbox_id IS NULL DO NOTHING`,
      [eventId],
    );

    for (const [column, value] of [
      ["state", "'queued'"],
      ["route_rule", "'header'"],
      ["classification", "'newsletter'"],
      ["disposition", "'reply'"],
      ["disposition_reason", "'unknown'"],
      ["spam_verdict", "'maybe'"],
      ["strip_confidence", "'partial'"],
      ["thread_match", "'subject'"],
    ] as const) {
      expect(
        await errorCode(database.execute(
          `UPDATE email_inbound_deliveries SET ${column} = ${value} WHERE inbound_event_id = $1`, [eventId],
        )),
        `${column} = ${value}`,
      ).toBe(CHECK_VIOLATION);
    }
    expect(await errorCode(database.execute(
      "UPDATE email_inbound_events SET state = 'queued' WHERE id = $1", [eventId],
    ))).toBe(CHECK_VIOLATION);
  });

  it("finds reservations forward and in reverse, and an event's deliveries, from their indexes", async () => {
    // A mailbox with a few thousand deliveries, so the plan reflects a mailbox's event log in use.
    const { workspaceId } = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "lookup.example");
    const mailboxId = await insertMailbox(workspaceId, domainId, "support@lookup.example");
    await database.execute(
      `WITH events AS (
         INSERT INTO email_inbound_events (provider, provider_event_id, event_kind, provider_object_id, envelope)
         SELECT 'resend', 'lookup-' || n, 'message_received', 'lookup-object-' || n, '{}'::jsonb
           FROM generate_series(1, 3000) AS n
         RETURNING id, provider_event_id
       )
       INSERT INTO email_inbound_deliveries (inbound_event_id, workspace_id, mailbox_id, state, rfc_message_id, reference_ids)
       SELECT id, $1, $2, 'done',
              '<' || provider_event_id || '@customer.example>',
              ARRAY['<parent-' || provider_event_id || '@customer.example>']
         FROM events`,
      [workspaceId, mailboxId],
    );
    await database.execute("ANALYZE email_inbound_deliveries");
    const explain = (query: string) =>
      database.withTransaction(async (client) => {
        await client.query("SET LOCAL enable_seqscan = off");
        const result = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${query}`);
        return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
      });

    expect(await explain(
      `SELECT planned_conversation_id FROM email_inbound_deliveries
        WHERE mailbox_id = '${mailboxId}' AND reference_ids @> ARRAY['<lookup-7@customer.example>']`,
    )).toContain("email_inbound_deliveries_reference_ids_idx");
    expect(await explain(
      `SELECT planned_conversation_id FROM email_inbound_deliveries
        WHERE mailbox_id = '${mailboxId}' AND rfc_message_id IN ('<lookup-7@customer.example>')
          AND state IN ('resolved', 'ingested')`,
    )).toContain("email_inbound_deliveries_reservation_idx");
    expect(await explain(
      `SELECT state FROM email_inbound_deliveries WHERE inbound_event_id = '${randomUUID()}'`,
    )).toContain("email_inbound_deliveries_event_mailbox_uniq");
  });

  it("deleting a workspace removes its email channel, including mail that never reached a conversation", async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "deletion.example");
    const mailboxId = await insertMailbox(workspaceId, domainId, "support@deletion.example", { agentId });
    await database.execute(
      "INSERT INTO email_mailbox_policies (mailbox_id, version, engagement_mode, enabled, agent_id) VALUES ($1, 1, 'operator_only', true, $2)",
      [mailboxId, agentId],
    );
    const { conversationId, messageId } = await insertConversation(workspaceId);
    await database.execute(
      `INSERT INTO email_thread_links (conversation_id, workspace_id, mailbox_id, thread_key, thread_token, participant_address)
       VALUES ($1, $2, $3, $4, $5, 'ana@customer.example')`,
      [conversationId, workspaceId, mailboxId, randomUUID(), randomUUID()],
    );
    const ingested = await database.queryOne<{ id: string }>(
      `INSERT INTO email_inbound_deliveries (inbound_event_id, workspace_id, mailbox_id, state, conversation_id, message_id)
       VALUES ($1, $2, $3, 'done', $4, $5) RETURNING id`,
      [await insertEvent(), workspaceId, mailboxId, conversationId, messageId],
    );
    await database.execute(
      `INSERT INTO email_thread_messages
         (workspace_id, mailbox_id, conversation_id, message_id, direction, origin, rfc_message_id, inbound_delivery_id)
       VALUES ($1, $2, $3, $4, 'inbound', 'inbound', '<ingested@customer.example>', $5)`,
      [workspaceId, mailboxId, conversationId, messageId, ingested.id],
    );
    // Dropped mail (an automated sender) and mail to an unknown address on a direct domain keep no
    // conversation, so only the mailbox and the workspace reach them.
    await database.execute(
      "INSERT INTO email_inbound_deliveries (inbound_event_id, workspace_id, mailbox_id, state, disposition) VALUES ($1, $2, $3, 'done', 'drop')",
      [await insertEvent(), workspaceId, mailboxId],
    );
    await database.execute(
      "INSERT INTO email_inbound_deliveries (inbound_event_id, workspace_id, disposition_reason) VALUES ($1, $2, 'no_mailbox')",
      [await insertEvent(), workspaceId],
    );

    await database.execute("DELETE FROM workspaces WHERE id = $1", [workspaceId]);

    const left = await database.queryOne<Record<string, string>>(
      `SELECT (SELECT count(*) FROM email_domains WHERE workspace_id = $1)::text AS domains,
              (SELECT count(*) FROM email_mailboxes WHERE workspace_id = $1)::text AS mailboxes,
              (SELECT count(*) FROM email_mailbox_policies WHERE mailbox_id = $2)::text AS policies,
              (SELECT count(*) FROM email_thread_links WHERE workspace_id = $1)::text AS links,
              (SELECT count(*) FROM email_thread_messages WHERE workspace_id = $1)::text AS index_rows,
              (SELECT count(*) FROM email_inbound_deliveries WHERE workspace_id = $1)::text AS deliveries`,
      [workspaceId, mailboxId],
    );
    expect(left).toEqual({ domains: "0", mailboxes: "0", policies: "0", links: "0", index_rows: "0", deliveries: "0" });
  });

  it("a hard delete of a mailbox with history is refused; removal is a soft delete", async () => {
    const { workspaceId } = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "restrict.example");
    const mailboxId = await insertMailbox(workspaceId, domainId, "support@restrict.example");
    await database.execute(
      "INSERT INTO email_inbound_deliveries (inbound_event_id, workspace_id, mailbox_id) VALUES ($1, $2, $3)",
      [await insertEvent(), workspaceId, mailboxId],
    );

    expect(await errorCode(database.execute("DELETE FROM email_mailboxes WHERE id = $1", [mailboxId])))
      .toBe(FOREIGN_KEY_VIOLATION);
    expect(await errorCode(database.execute("DELETE FROM email_domains WHERE id = $1", [domainId])))
      .toBe(FOREIGN_KEY_VIOLATION);
  });
  const insertFailure = (
    workspaceId: string,
    conversationId: string,
    messageId: string | null,
    kind = "bounced",
  ) =>
    database.queryOne<{ id: string; opened_to_the_millisecond: boolean }>(
      `INSERT INTO conversation_delivery_failures (workspace_id, conversation_id, message_id, provider, failure_kind)
       VALUES ($1, $2, $3, 'resend', $4)
       RETURNING id, opened_at = date_trunc('milliseconds', opened_at) AS opened_to_the_millisecond`,
      [workspaceId, conversationId, messageId, kind],
    );

  const insertIntent = (
    input: { workspaceId: string; mailboxId: string; conversationId: string; messageId: string },
    overrides: Record<string, string | null> = {},
  ) => {
    const values: Record<string, string | null> = {
      workspace_id: input.workspaceId,
      mailbox_id: input.mailboxId,
      conversation_id: input.conversationId,
      message_id: input.messageId,
      idempotency_key: `email:send:msg:${input.messageId}`,
      author_kind: "operator",
      trigger: "operator_reply",
      authority_snapshot: "{}",
      provider: "resend",
      supplied_rfc_message_id: `<${randomUUID()}@radioso.example>`,
      ...overrides,
    };
    const columns = Object.keys(values);
    return database.queryOne<{ id: string; state: string; version: number }>(
      `INSERT INTO email_send_intents (${columns.join(", ")})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING id, state, version`,
      Object.values(values),
    );
  };

  it("215 creates delivery failures on conversations and messages, after the activity widening", async () => {
    for (const file of activityWidening) {
      await applyTestMigration(database, file);
    }
    await applyTestMigration(database, deliveryFailures);

    expect(await foreignKeys("conversation_delivery_failures")).toEqual([
      { column: "conversation_id", target: "conversations", on_delete: "c" },
      { column: "message_id", target: "messages", on_delete: "c" },
    ]);
  });

  it("keeps one open delivery failure per message, with the documented kinds and clear reasons", async () => {
    const { workspaceId } = await seedWorkspace();
    const { conversationId, messageId } = await insertConversation(workspaceId);
    const failure = await insertFailure(workspaceId, conversationId, messageId);

    expect(failure.opened_to_the_millisecond).toBe(true);
    expect(await errorCode(insertFailure(workspaceId, conversationId, messageId, "failed"))).toBe(UNIQUE_VIOLATION);
    // A failure that names no message counts as one message.
    await insertFailure(workspaceId, conversationId, null);
    expect(await errorCode(insertFailure(workspaceId, conversationId, null))).toBe(UNIQUE_VIOLATION);
    // The writers' idempotent insert names the documented arbiter.
    await database.execute(
      `INSERT INTO conversation_delivery_failures (workspace_id, conversation_id, message_id, provider, failure_kind)
       VALUES ($1, $2, $3, 'resend', 'failed')
       ON CONFLICT (conversation_id, message_id) WHERE cleared_at IS NULL DO NOTHING`,
      [workspaceId, conversationId, messageId],
    );

    expect(await errorCode(insertFailure(workspaceId, conversationId, randomUUID()))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await errorCode(insertFailure(workspaceId, conversationId, messageId, "rejected"))).toBe(CHECK_VIOLATION);
    for (const assignment of [
      "cleared_at = now()",
      "clear_reason = 'later_delivery'",
      "cleared_by_user_id = gen_random_uuid()",
      "cleared_at = now(), clear_reason = 'dismissed'",
    ]) {
      expect(
        await errorCode(database.execute(
          `UPDATE conversation_delivery_failures SET ${assignment} WHERE id = $1`, [failure.id],
        )),
        assignment,
      ).toBe(CHECK_VIOLATION);
    }

    await database.execute(
      "UPDATE conversation_delivery_failures SET cleared_at = now(), clear_reason = 'acknowledged', cleared_by_user_id = gen_random_uuid() WHERE id = $1",
      [failure.id],
    );
    await insertFailure(workspaceId, conversationId, messageId, "failed");

    await database.execute("DELETE FROM messages WHERE id = $1", [messageId]);
    const left = await database.queryOne<{ count: string }>(
      "SELECT count(*)::text AS count FROM conversation_delivery_failures WHERE conversation_id = $1",
      [conversationId],
    );
    expect(left.count).toBe("1");
  });

  it("216 creates send intents and links the thread index to them", async () => {
    await applyTestMigration(database, sendIntents);

    expect(await foreignKeys("email_send_intents")).toEqual([
      { column: "conversation_id", target: "conversations", on_delete: "c" },
      { column: "mailbox_id", target: "email_mailboxes", on_delete: "r" },
      { column: "message_id", target: "messages", on_delete: "c" },
    ]);
    expect(await foreignKeys("email_thread_messages")).toContainEqual(
      { column: "send_intent_id", target: "email_send_intents", on_delete: "n" },
    );
  });

  it("keys send intents once by outbox key and provider id, and holds the send-intent states to the machine", async () => {
    const { workspaceId } = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "sends.example");
    const mailboxId = await insertMailbox(workspaceId, domainId, "support@sends.example");
    const { conversationId, messageId } = await insertConversation(workspaceId);
    const scope = { workspaceId, mailboxId, conversationId, messageId };

    const intent = await insertIntent(scope);
    expect(intent).toMatchObject({ state: "queued", version: 0 });
    expect(await errorCode(insertIntent(scope))).toBe(UNIQUE_VIOLATION);
    await database.execute(
      `INSERT INTO email_send_intents (workspace_id, mailbox_id, conversation_id, message_id, idempotency_key,
                                       author_kind, trigger, authority_snapshot, provider, supplied_rfc_message_id)
       VALUES ($1, $2, $3, $4, $5, 'operator', 'operator_reply', '{}'::jsonb, 'resend', '<again@radioso.example>')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [workspaceId, mailboxId, conversationId, messageId, `email:send:msg:${messageId}`],
    );

    const outsideTheMachine: Record<string, string>[] = [
      { idempotency_key: "" },
      { idempotency_key: "k".repeat(257) },
      { author_kind: "visitor" },
      { trigger: "auto_send" },
      { state: "sent" },
      { state: "halted" },
      { halt_reason: "sending_not_verified" },
      { state: "accepted" },
      { uncertain_resolution: "marked_sent" },
      { state: "uncertain", uncertain_resolution: "forgotten" },
      { state: "uncertain", uncertain_resolved_by_user_id: randomUUID() },
      { version: "-1" },
    ];
    for (const overrides of outsideTheMachine) {
      expect(
        await errorCode(insertIntent(scope, { idempotency_key: `k-${randomUUID()}`, ...overrides })),
        JSON.stringify(overrides),
      ).toBe(CHECK_VIOLATION);
    }
    await insertIntent(scope, { idempotency_key: `k-${randomUUID()}`, state: "halted", halt_reason: "domain_removed" });
    await insertIntent(scope, {
      idempotency_key: `k-${randomUUID()}`,
      state: "uncertain",
      uncertain_resolution: "marked_sent",
      uncertain_resolved_by_user_id: randomUUID(),
    });

    await database.execute(
      "UPDATE email_send_intents SET state = 'accepted', provider_message_id = 'p-1', version = version + 1 WHERE id = $1",
      [intent.id],
    );
    expect(await errorCode(insertIntent(scope, {
      idempotency_key: `k-${randomUUID()}`, state: "accepted", provider_message_id: "p-1",
    }))).toBe(UNIQUE_VIOLATION);
    // Another provider's id space is its own.
    await insertIntent(scope, {
      idempotency_key: `k-${randomUUID()}`, state: "accepted", provider: "local", provider_message_id: "p-1",
    });

    expect(await errorCode(insertIntent({ ...scope, mailboxId: randomUUID() }, { idempotency_key: `k-${randomUUID()}` })))
      .toBe(FOREIGN_KEY_VIOLATION);
    expect(await errorCode(database.execute("DELETE FROM email_mailboxes WHERE id = $1", [mailboxId])))
      .toBe(FOREIGN_KEY_VIOLATION);

    const indexRow = await database.queryOne<{ id: string }>(
      `INSERT INTO email_thread_messages
         (workspace_id, mailbox_id, conversation_id, message_id, direction, origin, rfc_message_id, send_intent_id)
       VALUES ($1, $2, $3, $4, 'outbound', 'radioso_generated', '<sent@radioso.example>', $5) RETURNING id`,
      [workspaceId, mailboxId, conversationId, messageId, intent.id],
    );
    expect(await errorCode(database.execute(
      "UPDATE email_thread_messages SET send_intent_id = $2 WHERE id = $1", [indexRow.id, randomUUID()],
    ))).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("claims due reconciliations from their partial index", async () => {
    const { workspaceId } = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "reconcile.example");
    const mailboxId = await insertMailbox(workspaceId, domainId, "support@reconcile.example");
    const { conversationId, messageId } = await insertConversation(workspaceId);
    await database.execute(
      `INSERT INTO email_send_intents (workspace_id, mailbox_id, conversation_id, message_id, idempotency_key, author_kind,
                                       trigger, state, authority_snapshot, provider, provider_message_id,
                                       supplied_rfc_message_id, next_reconcile_at)
       SELECT $1, $2, $3, $4, 'reconcile-' || n, 'operator', 'operator_reply',
              CASE WHEN n % 10 = 0 THEN 'accepted' ELSE 'delivered' END, '{}'::jsonb, 'resend', 'reconcile-p-' || n,
              '<reconcile-' || n || '@radioso.example>', CASE WHEN n % 10 = 0 THEN now() + (n || ' seconds')::interval END
         FROM generate_series(1, 3000) AS n`,
      [workspaceId, mailboxId, conversationId, messageId],
    );
    await database.execute("ANALYZE email_send_intents");
    const plan = await database.withTransaction(async (client) => {
      await client.query("SET LOCAL enable_seqscan = off");
      const result = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT id FROM email_send_intents
          WHERE state IN ('queued', 'accepted', 'uncertain') AND next_reconcile_at IS NOT NULL
            AND next_reconcile_at <= now() AND (reconcile_lease_until IS NULL OR reconcile_lease_until < now())
          ORDER BY next_reconcile_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
      );
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("email_send_intents_reconcile_due_idx");
  });
  const insertHeldReply = (
    input: { workspaceId: string; conversationId: string; messageId: string },
    overrides: Record<string, string | number | null> = {},
  ) => {
    const values: Record<string, string | number | null> = {
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      answers_message_id: input.messageId,
      ownership_version: 0,
      hold_reason: "draft_mode",
      turn_facts: "{}",
      draft_text: "Draft",
      draft_presentation: "{}",
      ...overrides,
    };
    const columns = Object.keys(values);
    return database.queryOne<{ id: string; state: string; suppressed_effects: unknown }>(
      `INSERT INTO held_replies (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
       RETURNING id, state, suppressed_effects`,
      columns.map((column) => values[column]),
    );
  };

  it("218 creates held replies on conversations and messages, and links send intents to them", async () => {
    expect((await database.query<{ id: string }>("SELECT to_regclass('held_replies') AS id"))[0]?.id).toBeNull();
    await applyTestMigration(database, heldReplies);

    expect(await foreignKeys("held_replies")).toEqual([
      { column: "answers_message_id", target: "messages", on_delete: "c" },
      { column: "conversation_id", target: "conversations", on_delete: "c" },
      { column: "released_message_id", target: "messages", on_delete: "n" },
    ]);
    expect(await foreignKeys("email_send_intents")).toContainEqual(
      { column: "held_reply_id", target: "held_replies", on_delete: "n" },
    );
  });

  it("keeps one live draft per conversation and one held reply per review, inside the held-reply machine", async () => {
    const { workspaceId } = await seedWorkspace();
    const { conversationId, messageId } = await insertConversation(workspaceId);
    const scope = { workspaceId, conversationId, messageId };

    const pending = await insertHeldReply(scope, { review_ref: "email:r1" });
    expect(pending).toMatchObject({ state: "pending", suppressed_effects: [] });
    expect(await errorCode(insertHeldReply(scope))).toBe(UNIQUE_VIOLATION);
    expect(await errorCode(insertHeldReply(scope, { state: "queued_auto" }))).toBe(UNIQUE_VIOLATION);
    const decided = { decided_at: new Date().toISOString(), attention_cleared_at: new Date().toISOString() };
    expect(await errorCode(insertHeldReply(scope, {
      state: "superseded", superseded_reason: "newer_inbound", attention_cleared_reason: "superseded", review_ref: "email:r1", ...decided,
    }))).toBe(UNIQUE_VIOLATION);
    await insertHeldReply(scope, {
      state: "superseded", superseded_reason: "newer_inbound", attention_cleared_reason: "superseded", review_ref: "email:r2", ...decided,
    });
    // Another conversation's review refs are its own.
    const other = await insertConversation(workspaceId);
    await insertHeldReply({ workspaceId, ...other }, { review_ref: "email:r1" });

    const outsideTheMachine: Record<string, string | number | null>[] = [
      { state: "sent" },
      { release_kind: "manual" },
      { superseded_reason: "expired" },
      { attention_cleared_reason: "forgotten" },
      { ownership_version: -1 },
      { policy_ref: "email_mailbox:x" },
      { policy_version: 1 },
      { state: "released", ...decided, attention_cleared_reason: "released" },
      { state: "released", release_kind: "operator", ...decided, attention_cleared_reason: "released" },
      { state: "edited", release_kind: "operator", releaser_user_id: randomUUID(), ...decided, attention_cleared_reason: "released" },
      { state: "discarded", decided_at: new Date().toISOString() },
      { state: "superseded", ...decided, attention_cleared_reason: "superseded" },
      { state: "pending", decided_at: new Date().toISOString() },
      { state: "pending", attention_cleared_at: new Date().toISOString(), attention_cleared_reason: "released" },
      { state: "released", release_kind: "auto", decided_at: new Date().toISOString() },
      { attention_cleared_at: new Date().toISOString() },
    ];
    for (const overrides of outsideTheMachine) {
      const conversation = await insertConversation(workspaceId);
      expect(
        await errorCode(insertHeldReply({ workspaceId, ...conversation }, overrides)),
        JSON.stringify(overrides),
      ).toBe(CHECK_VIOLATION);
    }
    const releasedConversation = await insertConversation(workspaceId);
    await insertHeldReply({ workspaceId, ...releasedConversation }, {
      state: "edited", release_kind: "operator", edited_text: "Edit", editor_user_id: randomUUID(),
      releaser_user_id: randomUUID(), ...decided, attention_cleared_reason: "released",
    });
    await insertHeldReply({ workspaceId, ...releasedConversation }, {
      state: "released", release_kind: "auto", ...decided, attention_cleared_reason: "released",
    });
    await insertHeldReply({ workspaceId, ...releasedConversation }, {
      state: "discarded", discarded_by_user_id: randomUUID(), decided_at: new Date().toISOString(),
    });
  });

  it("links a send intent to the held reply it delivers, and clears the link when the held reply goes", async () => {
    const { workspaceId } = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "held.example");
    const mailboxId = await insertMailbox(workspaceId, domainId, "support@held.example");
    const { conversationId, messageId } = await insertConversation(workspaceId);
    const held = await insertHeldReply({ workspaceId, conversationId, messageId });

    const intent = await insertIntent({ workspaceId, mailboxId, conversationId, messageId }, { held_reply_id: held.id });
    expect(await errorCode(insertIntent(
      { workspaceId, mailboxId, conversationId, messageId },
      { idempotency_key: `k-${randomUUID()}`, held_reply_id: randomUUID() },
    ))).toBe(FOREIGN_KEY_VIOLATION);

    await database.execute("DELETE FROM held_replies WHERE id = $1", [held.id]);
    expect((await database.queryOne<{ held_reply_id: string | null }>(
      "SELECT held_reply_id FROM email_send_intents WHERE id = $1", [intent.id],
    )).held_reply_id).toBeNull();
  });

  it("finds the attention list and a policy's live drafts from their partial indexes", async () => {
    const { workspaceId } = await seedWorkspace();
    const { conversationId, messageId } = await insertConversation(workspaceId);
    await database.execute(
      `INSERT INTO held_replies (workspace_id, conversation_id, answers_message_id, ownership_version, hold_reason, turn_facts,
                                 draft_text, draft_presentation, state, superseded_reason, attention_cleared_at,
                                 attention_cleared_reason, decided_at, policy_ref, policy_version)
       SELECT $1, $2, $3, 0, 'draft_mode', '{}'::jsonb, 'Draft', '{}'::jsonb, 'superseded', 'newer_inbound', now(), 'superseded', now(),
              'email_mailbox:' || (n % 50), 1
         FROM generate_series(1, 3000) AS n`,
      [workspaceId, conversationId, messageId],
    );
    await database.execute("ANALYZE held_replies");
    const plan = (query: string, params: unknown[]) => database.withTransaction(async (client) => {
      await client.query("SET LOCAL enable_seqscan = off");
      const result = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${query}`, params);
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

    expect(await plan(
      `SELECT id FROM held_replies WHERE workspace_id = $1 AND attention_cleared_at IS NULL AND state <> 'queued_auto'
        ORDER BY created_at DESC, id DESC LIMIT 20`,
      [workspaceId],
    )).toContain("held_replies_workspace_attention_idx");
    expect(await plan(
      "UPDATE held_replies SET state = 'superseded' WHERE policy_ref = $1 AND state IN ('pending', 'queued_auto')",
      ["email_mailbox:1"],
    )).toContain("held_replies_live_policy_idx");
  });

  it("219 drops the mailbox's thread-context and spam opt-in columns and keeps its mailboxes and settings", async () => {
    const mailboxColumns = async () => (await database.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'email_mailboxes'",
    )).map((row) => row.column_name);
    const { workspaceId } = await seedWorkspace();
    const domainId = await insertDomain(workspaceId, "trim.example");
    const mailboxId = await insertMailbox(workspaceId, domainId, "support@trim.example");
    await database.execute(
      "UPDATE email_mailboxes SET thread_send_budget = 7, thread_context_messages = 20, spam_opt_in = true WHERE id = $1",
      [mailboxId],
    );
    expect(await mailboxColumns()).toEqual(expect.arrayContaining(["thread_context_messages", "spam_opt_in"]));

    await applyTestMigration(database, mailboxSettingsTrim);

    const columns = await mailboxColumns();
    expect(columns).not.toContain("thread_context_messages");
    expect(columns).not.toContain("spam_opt_in");
    expect(await database.queryOne<Record<string, unknown>>(
      "SELECT address, thread_send_budget, hourly_generation_budget, silence_threshold_hours FROM email_mailboxes WHERE id = $1",
      [mailboxId],
    )).toEqual({ address: "support@trim.example", thread_send_budget: 7, hourly_generation_budget: 30, silence_threshold_hours: 72 });
  });
});
