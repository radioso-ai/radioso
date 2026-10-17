import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  createPostgresConversationErasureUnitOfWork,
  createWorkspaceConversationDataErasure,
} from "../../src/app/composition/conversationErasure.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AuditEventRepository } from "../../src/db/repositories/auditEventRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { ConversationErasureService } from "../../src/modules/privacy/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/**
 * The Enterprise Edition's per-period reply counter, as its own migrator creates it. A quota
 * counter, not conversation content: erasing a conversation must leave it, or deleting
 * conversations would reset a tenant's quota.
 */
const EE_REPLY_COUNTER_DDL = `
  CREATE TABLE IF NOT EXISTS ee_usage_limit_conversation_replies (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    conversation_id UUID NOT NULL,
    reply_count INTEGER NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, period_start, conversation_id)
  )`;

interface Tenant {
  accountId: string;
  workspaceId: string;
  agentId: string;
  revisionId: string;
  variableId: string;
  skillId: string;
  connectionId: string;
}

interface SeededConversation {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  chatSessionId: string;
  pendingDecisionId: string;
  inboundEventId: string;
  evalCaseId: string;
}

describeIntegration("conversation erasure (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const invalidation = { enqueue: vi.fn() };
  const erasure = new ConversationErasureService({
    unitOfWork: createPostgresConversationErasureUnitOfWork({ db: database.kysely, logger: { warn: vi.fn() } }),
    invalidation,
    auditLog: {},
  });
  const actor = (tenant: Tenant) => ({ accountId: tenant.accountId, userId: null });
  const seededAccountIds: string[] = [];

  beforeAll(async () => {
    await runAllTestMigrations(database);
    await database.execute(EE_REPLY_COUNTER_DDL);
  });

  afterAll(async () => {
    // Every tenant goes, through the same organization deletion production runs, so no queued job
    // or row this file seeded reaches another file sharing the database.
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());
    for (const accountId of seededAccountIds) {
      await lifecycle.deleteAccount({
        accountId,
        auditEvent: { accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
      });
    }
    await database.execute("DROP TABLE IF EXISTS ee_usage_limit_conversation_replies").catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const seedTenant = async (): Promise<Tenant> => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Erasure",
      email: `erasure-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Erasure Workspace");
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Support')", [agentId, workspace.id]);
    const revisionId = randomUUID();
    await database.query(
      "INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation) VALUES ($1, $2, $3, '{}'::jsonb, 1)",
      [revisionId, agentId, workspace.id],
    );
    const [variable] = await database.query<{ id: string }>(
      `INSERT INTO context_variables (workspace_id, name, value_type, trust_tier, sensitivity, default_surfacing)
       VALUES ($1, 'cart', 'json', 'unverified', 'normal', 'on_reference') RETURNING id`,
      [workspace.id],
    );
    const oauthConnectionId = randomUUID();
    await database.query(
      "INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name) VALUES ($1, $2, 'google', 'Mail')",
      [oauthConnectionId, workspace.id],
    );
    const connectionId = randomUUID();
    await database.query(
      "INSERT INTO integration_connections (id, workspace_id, oauth_connection_id, provider, display_name) VALUES ($1, $2, $3, 'customer_email_google', 'Mail')",
      [connectionId, workspace.id, oauthConnectionId],
    );
    const skillId = randomUUID();
    await database.query(
      `INSERT INTO agent_skills (id, agent_id, workspace_id, skill_name, kind, target_type, target_id)
       VALUES ($1, $2, $3, 'send_quote', 'customer_email', 'customer_email_connection', $4)`,
      [skillId, agentId, workspace.id, connectionId],
    );
    return { accountId: account.id, workspaceId: workspace.id, agentId, revisionId, variableId: variable.id, skillId, connectionId };
  };

  const seedVisitor = async (tenant: Tenant, verifiedCustomerId: string | null): Promise<string> => {
    const [visitor] = await database.query<{ id: string }>(
      "INSERT INTO visitors (workspace_id, visitor_key, verified_customer_id, conversation_count) VALUES ($1, $2, $3, 0) RETURNING id",
      [tenant.workspaceId, `visitor-key-${randomUUID()}`, verifiedCustomerId],
    );
    return visitor.id;
  };

  /** One conversation and a row in every place that keeps something derived from it. */
  const seedConversation = async (
    tenant: Tenant,
    options: { visitorId?: string | null; chatSessionId?: string; verifiedCustomerId?: string | null } = {},
  ): Promise<SeededConversation> => {
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const chatSessionId = options.chatSessionId ?? `session-${randomUUID()}`;
    const { workspaceId } = tenant;
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, anonymous_session_id, visitor_id, verified_customer_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [conversationId, workspaceId, tenant.agentId, chatSessionId, options.visitorId ?? null, options.verifiedCustomerId ?? null],
    );
    if (options.visitorId) {
      await database.query("UPDATE visitors SET conversation_count = conversation_count + 1 WHERE id = $1", [options.visitorId]);
    }
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES
         ($1, $3, $4, 'user', 'My order 1182 never arrived'),
         ($2, $3, $4, 'assistant', 'Sorry to hear that. Let me check.')`,
      [userMessageId, assistantMessageId, conversationId, workspaceId],
    );
    await database.query(
      `INSERT INTO conversation_summaries (session_id, summary, covered_message_count, covered_through, expires_at)
       VALUES ($1, 'Order 1182 missing', 2, now(), now() + interval '1 day')`,
      [conversationId],
    );
    await database.query(
      "INSERT INTO facet_extraction_jobs (message_id, workspace_id, status) VALUES ($1, $2, 'queued')",
      [userMessageId, workspaceId],
    );
    await database.query(
      `INSERT INTO routine_states (session_id, routine_id, variables) VALUES ($1, 'refund', '{"order": "1182"}'::jsonb)`,
      [conversationId],
    );
    await database.query(
      "INSERT INTO clarification_states (session_id, source, expires_at, original_query) VALUES ($1, 'retrieval', now() + interval '1 hour', 'order 1182')",
      [conversationId],
    );
    await database.query("INSERT INTO directive_states (session_id) VALUES ($1)", [conversationId]);
    const [decision] = await database.query<{ id: string }>(
      `INSERT INTO pending_decisions (handle, conversation_id, session_id, workspace_id, agent_id, routine_id, step_id, decider_scope, content_hash)
       VALUES ($1, $2, $2, $3, $4, 'refund', 'approve', '{}'::jsonb, 'sha256:x') RETURNING id`,
      [`decision-${randomUUID()}`, conversationId, workspaceId, tenant.agentId],
    );
    await database.query(
      "INSERT INTO approval_resume_effect_decisions (pending_decision_id, option_id, payload_digest) VALUES ($1, 'approve', 'digest')",
      [decision.id],
    );
    await database.query(
      `INSERT INTO routine_action_requests (type, payload, workspace_id, conversation_id)
       VALUES ('notify.send', '{"summary": "Order 1182 missing"}'::jsonb, $1, $2)`,
      [workspaceId, conversationId],
    );
    await database.query(
      `INSERT INTO notification_delivery_outcomes
         (request_id, recipient_digest, workspace_id, conversation_id, usage_date, requested_email_count, reserved_email_count, outcome, daily_email_limit, conversation_dispatch_limit)
       VALUES ($1, 'digest', $2, $3, current_date, 1, 1, 'allowed', 100, 5)`,
      [randomUUID(), workspaceId, conversationId],
    );
    await database.query(
      `INSERT INTO email_skill_activity (id, workspace_id, agent_id, conversation_id, skill_definition_id, connection_id, skill_name, mode, outcome, recipient_summary)
       VALUES ($1, $2, $3, $4, $5, $6, 'send_quote', 'send', 'sent', '{"toCount": 1, "ccCount": 0, "domains": ["example.com"], "redactedRecipients": ["j***@example.com"]}'::jsonb)`,
      [randomUUID(), workspaceId, tenant.agentId, conversationId, tenant.skillId, tenant.connectionId],
    );
    const [event] = await database.query<{ id: string }>(
      `INSERT INTO email_inbound_events (provider, provider_event_id, event_kind, envelope, state)
       VALUES ('local', $1, 'message_received', '{"from": "jane@example.com"}'::jsonb, 'processed') RETURNING id`,
      [`evt-${randomUUID()}`],
    );
    // One delivery ingest attached, and one still reserved for the conversation.
    await database.query(
      `INSERT INTO email_inbound_deliveries (inbound_event_id, workspace_id, state, sender_address, body_text, conversation_id, planned_conversation_id)
       VALUES ($1, $2, 'done', 'jane@example.com', 'Where is my order?', $3, $3)`,
      [event.id, workspaceId, conversationId],
    );
    const [laterEvent] = await database.query<{ id: string }>(
      `INSERT INTO email_inbound_events (provider, provider_event_id, event_kind, envelope, state)
       VALUES ('local', $1, 'message_received', '{"from": "jane@example.com"}'::jsonb, 'processed') RETURNING id`,
      [`evt-${randomUUID()}`],
    );
    await database.query(
      `INSERT INTO email_inbound_deliveries (inbound_event_id, workspace_id, state, sender_address, body_text, planned_conversation_id, planned_message_id)
       VALUES ($1, $2, 'resolved', 'jane@example.com', 'Any news?', $3, $4)`,
      [laterEvent.id, workspaceId, conversationId, randomUUID()],
    );
    await database.query(
      `INSERT INTO context_variable_values (workspace_id, variable_id, scope_type, scope_id, data)
       VALUES ($1, $2, 'session', $3, '{"items": ["boots"]}'::jsonb)
       ON CONFLICT (variable_id, scope_type, scope_id) DO NOTHING`,
      [workspaceId, tenant.variableId, chatSessionId],
    );
    await database.query(
      `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json) VALUES
         ($1, $4, $5, 'chat.answer', 'success', jsonb_build_object('conversationId', $6::text, 'suggestions', '["Track order 1182"]'::jsonb, 'rewriteContinuityState', '{"query": "order 1182"}'::jsonb)),
         ($2, $4, $5, 'chat.suspended', 'success', jsonb_build_object('conversationId', $6::text, 'suggestions', '["Approve refund"]'::jsonb)),
         ($3, $4, $5, 'hitl.ownership', 'success', jsonb_build_object('conversationId', $6::text, 'action', 'handoff_requested'))`,
      [randomUUID(), randomUUID(), randomUUID(), tenant.accountId, workspaceId, conversationId],
    );
    await database.query(
      `INSERT INTO usage_events (id, idempotency_key, account_id, workspace_id, conversation_id, message_id, surface, operation, provider, model, status, usage_quality, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, 'assistant', 'chat', 'openai', 'gpt-mini', 'success', 'exact', 120)`,
      [randomUUID(), `usage-${randomUUID()}`, tenant.accountId, workspaceId, conversationId, assistantMessageId],
    );
    await database.query(
      "INSERT INTO ee_usage_limit_conversation_replies (account_id, period_start, conversation_id, reply_count) VALUES ($1, date_trunc('month', now())::date, $2, 1)",
      [tenant.accountId, conversationId],
    );
    // The turn kept as an eval case: its snapshot copies the messages, and a run and a revision eval
    // replayed it.
    const snapshotId = randomUUID();
    await database.query(
      `INSERT INTO eval_snapshots (id, workspace_id, source_conversation_id, source_message_id, fidelity, messages)
       VALUES ($1, $2, $3, $4, 'messages_only', '[{"role": "user", "content": "My order 1182 never arrived"}]'::jsonb)`,
      [snapshotId, workspaceId, conversationId, assistantMessageId],
    );
    const evalCaseId = randomUUID();
    await database.query(
      "INSERT INTO eval_cases (id, workspace_id, snapshot_id, name, status) VALUES ($1, $2, $3, 'Missing order', 'pending')",
      [evalCaseId, workspaceId, snapshotId],
    );
    await database.query(
      "INSERT INTO eval_runs (id, workspace_id, snapshot_id, case_id, mode, status) VALUES ($1, $2, $3, $4, 'full_assistant', 'recorded')",
      [randomUUID(), workspaceId, snapshotId, evalCaseId],
    );
    const revisionRunId = randomUUID();
    await database.query(
      `INSERT INTO revision_eval_runs (id, workspace_id, agent_id, mode, execution_policy, test_values, state, idempotency_key)
       VALUES ($1, $2, $3, 'full_assistant', 'safe_test', '[]'::jsonb, 'completed', $4)`,
      [revisionRunId, workspaceId, tenant.agentId, `revision-eval-${randomUUID()}`],
    );
    const sideId = randomUUID();
    await database.query(
      "INSERT INTO revision_eval_run_sides (id, run_id, revision_id, side_ordinal, frozen_revision, state) VALUES ($1, $2, $3, 0, '{}'::jsonb, 'completed')",
      [sideId, revisionRunId, tenant.revisionId],
    );
    await database.query(
      `INSERT INTO revision_eval_run_cases (id, side_id, case_id, frozen_case, frozen_snapshot, state, outcome)
       VALUES ($1, $2, $3, '{}'::jsonb, '{"messages": [{"content": "My order 1182 never arrived"}]}'::jsonb, 'completed', 'pass')`,
      [randomUUID(), sideId, evalCaseId],
    );
    return {
      conversationId,
      userMessageId,
      assistantMessageId,
      chatSessionId,
      pendingDecisionId: decision.id,
      inboundEventId: event.id,
      evalCaseId,
    };
  };

  const count = async (sql: string, params: unknown[]): Promise<number> => {
    const [row] = await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${sql}`, params);
    return Number(row.count);
  };

  /** Every row the seed wrote for the conversation, by where it lives. */
  const derivedRows = async (seeded: SeededConversation) => ({
    conversations: await count("conversations WHERE id = $1", [seeded.conversationId]),
    messages: await count("messages WHERE conversation_id = $1", [seeded.conversationId]),
    conversation_summaries: await count("conversation_summaries WHERE session_id = $1", [seeded.conversationId]),
    facet_extraction_jobs: await count("facet_extraction_jobs WHERE message_id = $1", [seeded.userMessageId]),
    routine_states: await count("routine_states WHERE session_id = $1", [seeded.conversationId]),
    clarification_states: await count("clarification_states WHERE session_id = $1", [seeded.conversationId]),
    directive_states: await count("directive_states WHERE session_id = $1", [seeded.conversationId]),
    pending_decisions: await count("pending_decisions WHERE conversation_id = $1", [seeded.conversationId]),
    approval_resume_effect_decisions: await count("approval_resume_effect_decisions WHERE pending_decision_id = $1", [seeded.pendingDecisionId]),
    routine_action_requests: await count("routine_action_requests WHERE conversation_id = $1", [seeded.conversationId]),
    email_skill_activity: await count("email_skill_activity WHERE conversation_id = $1", [seeded.conversationId]),
    email_inbound_deliveries: await count(
      "email_inbound_deliveries WHERE conversation_id = $1 OR planned_conversation_id = $1",
      [seeded.conversationId],
    ),
    email_inbound_events: await count("email_inbound_events WHERE id = $1", [seeded.inboundEventId]),
    session_context_values: await count(
      "context_variable_values WHERE scope_type = 'session' AND scope_id = $1",
      [seeded.chatSessionId],
    ),
    eval_snapshots: await count("eval_snapshots WHERE source_conversation_id = $1", [seeded.conversationId]),
    eval_cases: await count("eval_cases WHERE id = $1", [seeded.evalCaseId]),
    eval_runs: await count("eval_runs WHERE case_id = $1", [seeded.evalCaseId]),
    revision_eval_run_cases: await count("revision_eval_run_cases WHERE case_id = $1", [seeded.evalCaseId]),
    chat_turn_audit_events: await count(
      "audit_events WHERE event_type IN ('chat.answer', 'chat.suspended') AND metadata_json->>'conversationId' = $1",
      [seeded.conversationId],
    ),
  });

  const allGone = (rows: Record<string, number>) =>
    Object.fromEntries(Object.keys(rows).map((key) => [key, 0]));

  it("erasing a conversation removes every row derived from it, and only from it", async () => {
    const tenant = await seedTenant();
    const erased = await seedConversation(tenant);
    const kept = await seedConversation(tenant);
    const keptBefore = await derivedRows(kept);

    const receipt = await erasure.eraseConversation({
      workspaceId: tenant.workspaceId,
      conversationId: erased.conversationId,
      actor: actor(tenant),
    });

    const after = await derivedRows(erased);
    expect(after).toEqual(allGone(after));
    expect(await derivedRows(kept)).toEqual(keptBefore);
    expect(receipt).toEqual({
      conversationCount: 1,
      messageCount: 2,
      rowsByOwner: { "context-variables": 1, audit: 2, "email-channel": 4, "customer-email": 1, eval: 3, whatsapp: 0, "audience-pulse": 0 },
    });
  });

  it("keeps the billing ledger and the quota counters with the conversation link cleared", async () => {
    const tenant = await seedTenant();
    const erased = await seedConversation(tenant);

    await erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: erased.conversationId, actor: actor(tenant) });

    const usage = await database.query<{ conversation_id: string | null; message_id: string | null; total_tokens: number }>(
      "SELECT conversation_id, message_id, total_tokens::int AS total_tokens FROM usage_events WHERE workspace_id = $1",
      [tenant.workspaceId],
    );
    expect(usage).toEqual([{ conversation_id: null, message_id: null, total_tokens: 120 }]);
    const outcomes = await database.query<{ conversation_id: string | null; reserved_email_count: number }>(
      "SELECT conversation_id, reserved_email_count FROM notification_delivery_outcomes WHERE workspace_id = $1",
      [tenant.workspaceId],
    );
    expect(outcomes).toEqual([{ conversation_id: null, reserved_email_count: 1 }]);
    expect(await count("ee_usage_limit_conversation_replies WHERE conversation_id = $1", [erased.conversationId])).toBe(1);
  });

  it("records one content-free audit event and keeps the content-free events that name the conversation", async () => {
    const tenant = await seedTenant();
    const erased = await seedConversation(tenant);

    await erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: erased.conversationId, actor: actor(tenant) });

    const events = await database.query<{ event_type: string; metadata_json: Record<string, unknown> }>(
      "SELECT event_type, metadata_json FROM audit_events WHERE workspace_id = $1 ORDER BY created_at",
      [tenant.workspaceId],
    );
    expect(events.map((event) => event.event_type)).toEqual(["hitl.ownership", "conversation.erased"]);
    expect(events[1].metadata_json).toEqual({
      actorUserId: null,
      conversationId: erased.conversationId,
      conversationCount: 1,
      messageCount: 2,
      rowsByOwner: { "context-variables": 1, audit: 2, "email-channel": 4, "customer-email": 1, eval: 3, whatsapp: 0, "audience-pulse": 0 },
    });
    expect(invalidation.enqueue).toHaveBeenCalledWith(tenant.workspaceId, ["conversation.deleted"]);
  });

  it("refuses a conversation of another workspace and leaves it whole", async () => {
    const tenant = await seedTenant();
    const other = await seedTenant();
    const foreign = await seedConversation(other);
    const before = await derivedRows(foreign);

    await expect(erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: foreign.conversationId, actor: actor(tenant) }))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(await derivedRows(foreign)).toEqual(before);
    expect(await count("audit_events WHERE workspace_id = $1 AND event_type = 'conversation.erased'", [tenant.workspaceId])).toBe(0);
  });

  it("keeps a chat session's values while another conversation still carries the session", async () => {
    const tenant = await seedTenant();
    const erased = await seedConversation(tenant);
    await seedConversation(tenant, { chatSessionId: erased.chatSessionId });

    await erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: erased.conversationId, actor: actor(tenant) });

    expect(await count("context_variable_values WHERE scope_type = 'session' AND scope_id = $1", [erased.chatSessionId])).toBe(1);
  });

  it("lowers the visitor's conversation count when one of their conversations is erased", async () => {
    const tenant = await seedTenant();
    const visitorId = await seedVisitor(tenant, null);
    const erased = await seedConversation(tenant, { visitorId });
    await seedConversation(tenant, { visitorId });

    await erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: erased.conversationId, actor: actor(tenant) });

    const [visitor] = await database.query<{ conversation_count: number }>("SELECT conversation_count FROM visitors WHERE id = $1", [visitorId]);
    expect(visitor.conversation_count).toBe(1);
  });

  it("removes a visitor left with no conversation once their last one is erased", async () => {
    const tenant = await seedTenant();
    const visitorId = await seedVisitor(tenant, null);
    const only = await seedConversation(tenant, { visitorId });

    await erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: only.conversationId, actor: actor(tenant) });

    expect(await count("visitors WHERE id = $1", [visitorId])).toBe(0);
  });

  /**
   * Polls `pg_stat_activity` until some backend other than `excludePid` is waiting on a lock, with
   * a bounded timeout instead of a fixed sleep. The visitor auto-delete (or, fixed, its preceding
   * `SELECT ... FOR UPDATE`) needs the full `FOR UPDATE` tuple-lock strength,
   * which conflicts with the `FOR KEY SHARE` a concurrent insert's foreign-key check holds on the
   * same visitor row — so this reliably observes the erasure actually blocked on that hold, not a
   * guess about how long it takes to get there.
   */
  const waitUntilBlockedOnLock = async (excludePid: number): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const blocked = await database.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> $1",
        [excludePid],
      );
      if (blocked.length > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for the erasure to block on the held visitor lock");
  };

  it("keeps a visitor whose last other conversation is erased while a new conversation for them is committing", async () => {
    const tenant = await seedTenant();
    const visitorId = await seedVisitor(tenant, null);
    const erased = await seedConversation(tenant, { visitorId });

    // Connection A: starts a conversation insert for the same visitor and holds the transaction
    // open. Inserting a row with a foreign key to `visitors` takes a FOR KEY SHARE lock on the
    // referenced visitor row for the life of this transaction.
    const holding = await database.pool.connect();
    try {
      await holding.query("BEGIN");
      const { rows: [{ pid: holdingPid }] } = await holding.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const concurrentConversationId = randomUUID();
      await holding.query(
        `INSERT INTO conversations (id, workspace_id, agent_id, anonymous_session_id, visitor_id) VALUES ($1, $2, $3, $4, $5)`,
        [concurrentConversationId, tenant.workspaceId, tenant.agentId, `session-${randomUUID()}`, visitorId],
      );

      // Connection B (the pool the erasure runs on): erase the visitor's only other conversation.
      // Its visitor delete (or lock) needs FOR UPDATE strength, which conflicts with A's hold, so
      // it blocks until A commits.
      const erasurePromise = erasure.eraseConversation({
        workspaceId: tenant.workspaceId,
        conversationId: erased.conversationId,
        actor: actor(tenant),
      });

      await waitUntilBlockedOnLock(holdingPid);
      await holding.query("COMMIT");
      await erasurePromise;

      // The visitor survives: its row didn't change while A was held, so a stale snapshot taken
      // before A committed must not be what decided whether it still has a conversation.
      expect(await count("visitors WHERE id = $1", [visitorId])).toBe(1);
      const [concurrentConversation] = await database.query<{ visitor_id: string | null }>(
        "SELECT visitor_id FROM conversations WHERE id = $1",
        [concurrentConversationId],
      );
      expect(concurrentConversation.visitor_id).toBe(visitorId);
    } finally {
      holding.release();
    }
  });

  /** How many `chat.answer` audit events, of any status, still name this conversation. */
  const chatAnswerAuditCount = (tenant: Tenant, conversationId: string) =>
    count(
      "audit_events WHERE workspace_id = $1 AND event_type = 'chat.answer' AND metadata_json->>'conversationId' = $2",
      [tenant.workspaceId, conversationId],
    );

  it("skips a failed turn's chat.answer audit once its conversation has already been erased", async () => {
    const tenant = await seedTenant();
    const erased = await seedConversation(tenant);
    const auditEventRepository = new AuditEventRepository(database.kysely);

    await erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: erased.conversationId, actor: actor(tenant) });

    const created = await auditEventRepository.createIfConversationLive({
      workspaceId: tenant.workspaceId,
      conversationId: erased.conversationId,
      eventType: "chat.answer",
      eventStatus: "failure",
      metadata: { stage: "chat.answer" },
    });

    expect(created).toBeNull();
    expect(await chatAnswerAuditCount(tenant, erased.conversationId)).toBe(0);
  });

  it("keeps a failed turn's chat.answer audit from surviving a conversation erasure racing it", async () => {
    const tenant = await seedTenant();
    // A bare conversation, with nothing derived from it, so the row's removal below (standing
    // in for the real erasure's cascade) cannot meet a foreign key it isn't this test's job to
    // reason about; the lock this test races is on the conversation row alone.
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, anonymous_session_id) VALUES ($1, $2, $3, $4)",
      [conversationId, tenant.workspaceId, tenant.agentId, `session-${randomUUID()}`],
    );
    const auditEventRepository = new AuditEventRepository(database.kysely);

    // Connection A: takes the same row lock the first step of a live erasure takes
    // (`ConversationRepository.lockForUpdate`) and holds the transaction open.
    const holding = await database.pool.connect();
    try {
      await holding.query("BEGIN");
      const { rows: [{ pid: holdingPid }] } = await holding.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await holding.query(
        "SELECT id FROM conversations WHERE id = $1 AND workspace_id = $2 FOR NO KEY UPDATE",
        [conversationId, tenant.workspaceId],
      );

      // Connection B (the pool the write under test runs on): the failure path's conditional
      // audit write. Its existence check takes `FOR SHARE`, which conflicts with A's hold, so
      // it blocks until A finishes — a `FOR KEY SHARE` check would not have blocked here.
      const writePromise = auditEventRepository.createIfConversationLive({
        workspaceId: tenant.workspaceId,
        conversationId,
        eventType: "chat.answer",
        eventStatus: "failure",
        metadata: { stage: "chat.answer" },
      });

      await waitUntilBlockedOnLock(holdingPid);
      // A finishes what this test cares about from the erasure: the conversation's row is gone
      // by the time its transaction commits, exactly as the real erasure's cascade leaves it.
      await holding.query("DELETE FROM conversations WHERE id = $1 AND workspace_id = $2", [conversationId, tenant.workspaceId]);
      await holding.query("COMMIT");

      expect(await writePromise).toBeNull();
      expect(await chatAnswerAuditCount(tenant, conversationId)).toBe(0);
    } finally {
      holding.release();
    }
  });

  it("keeps a verified visitor whose last conversation is erased, so a later visitor erase can still reach their customer-scoped values", async () => {
    const tenant = await seedTenant();
    const visitorId = await seedVisitor(tenant, "customer-99");
    const only = await seedConversation(tenant, { visitorId, verifiedCustomerId: "customer-99" });
    await database.query(
      `INSERT INTO context_variable_values (workspace_id, variable_id, scope_type, scope_id, data)
       VALUES ($1, $2, 'customer', 'customer-99', '{"tier": "gold"}'::jsonb)`,
      [tenant.workspaceId, tenant.variableId],
    );

    await erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: only.conversationId, actor: actor(tenant) });

    // A verified identity belongs to the customer, not to one conversation: the visitor row stays
    // as the handle a later visitor erase needs to reach customer-scoped context values through.
    expect(await count("visitors WHERE id = $1", [visitorId])).toBe(1);
    const [visitor] = await database.query<{ conversation_count: number }>(
      "SELECT conversation_count FROM visitors WHERE id = $1",
      [visitorId],
    );
    expect(visitor.conversation_count).toBe(0);

    const receipt = await erasure.eraseVisitor({ workspaceId: tenant.workspaceId, visitorId, actor: actor(tenant) });

    expect(await count("visitors WHERE id = $1", [visitorId])).toBe(0);
    expect(await count("context_variable_values WHERE scope_type = 'customer' AND scope_id = $1", ["customer-99"])).toBe(0);
    expect(receipt).toMatchObject({ conversationCount: 0, messageCount: 0 });
  });

  it("erases the WhatsApp transport log of the number whose conversation is erased, and only that number's", async () => {
    const tenant = await seedTenant();
    const erased = await seedConversation(tenant);
    const kept = await seedConversation(tenant);
    const contact = async (waId: string, conversationId: string) => {
      await database.query(
        "INSERT INTO connector_whatsapp_contacts (id, wa_id, workspace_id, conversation_id) VALUES ($1, $2, $3, $4)",
        [randomUUID(), waId, tenant.workspaceId, conversationId],
      );
      await database.query(
        `INSERT INTO connector_whatsapp_message_log (wamid, direction, workspace_id, wa_id, message_type, payload, status)
         VALUES ($1, 'inbound', $2, $3, 'text', '{"text": {"body": "My order 1182 never arrived"}}'::jsonb, 'replied'),
                ($4, 'outbound', $2, $3, 'text', '{"text": {"body": "Let me check."}}'::jsonb, 'replied')`,
        [`wamid-${randomUUID()}`, tenant.workspaceId, waId, `wamid-${randomUUID()}`],
      );
    };
    await contact("4915112345678", erased.conversationId);
    await contact("4915187654321", kept.conversationId);

    await erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: erased.conversationId, actor: actor(tenant) });

    const remaining = await database.query<{ wa_id: string }>(
      "SELECT wa_id FROM connector_whatsapp_message_log WHERE workspace_id = $1",
      [tenant.workspaceId],
    );
    expect(remaining.map((row) => row.wa_id)).toEqual(["4915187654321", "4915187654321"]);
    expect(await count("connector_whatsapp_contacts WHERE conversation_id = $1", [erased.conversationId])).toBe(0);
  });

  it("discards the Audience Pulse report built on an erased conversation's question, and keeps one that is not", async () => {
    const seedSnapshot = async (tenant: Tenant, seeded: SeededConversation) => {
      await database.query(
        `INSERT INTO audience_pulse_snapshots (workspace_id, revision, period_start, period_end, generated_at, report, prompt_evidence_refs)
         VALUES ($1, $2, now() - interval '28 days', now(), now(),
                 jsonb_build_object('recommendations', jsonb_build_array(jsonb_build_object('questions', jsonb_build_array('Where is order 1182?'), 'evidenceIds', jsonb_build_array($3::text)))),
                 jsonb_build_array(jsonb_build_object('evidenceId', $3::text, 'messageId', $3::text, 'conversationId', $4::text)))`,
        [tenant.workspaceId, randomUUID(), seeded.userMessageId, seeded.conversationId],
      );
    };
    const tenant = await seedTenant();
    const erased = await seedConversation(tenant);
    await seedSnapshot(tenant, erased);
    const otherTenant = await seedTenant();
    const otherConversation = await seedConversation(otherTenant);
    await seedSnapshot(otherTenant, otherConversation);
    const unrelated = await seedConversation(otherTenant);

    await erasure.eraseConversation({ workspaceId: tenant.workspaceId, conversationId: erased.conversationId, actor: actor(tenant) });
    await erasure.eraseConversation({ workspaceId: otherTenant.workspaceId, conversationId: unrelated.conversationId, actor: actor(otherTenant) });

    expect(await count("audience_pulse_snapshots WHERE workspace_id = $1", [tenant.workspaceId])).toBe(0);
    expect(await count("audience_pulse_snapshots WHERE workspace_id = $1", [otherTenant.workspaceId])).toBe(1);
  });

  it("erasing a visitor removes every conversation they had, their customer-scoped values, and the visitor row", async () => {
    const tenant = await seedTenant();
    const visitorId = await seedVisitor(tenant, "customer-42");
    const first = await seedConversation(tenant, { visitorId, verifiedCustomerId: "customer-42" });
    const second = await seedConversation(tenant, { visitorId, verifiedCustomerId: "customer-42" });
    const someoneElse = await seedConversation(tenant);
    await database.query(
      `INSERT INTO context_variable_values (workspace_id, variable_id, scope_type, scope_id, data) VALUES
         ($1, $2, 'customer', 'customer-42', '{"tier": "gold"}'::jsonb),
         ($1, $2, 'customer', 'customer-7', '{"tier": "silver"}'::jsonb),
         ($1, $2, 'agent', $3, '{"promo": "autumn"}'::jsonb)`,
      [tenant.workspaceId, tenant.variableId, tenant.agentId],
    );
    const someoneElseBefore = await derivedRows(someoneElse);

    const receipt = await erasure.eraseVisitor({ workspaceId: tenant.workspaceId, visitorId, actor: actor(tenant) });

    for (const seeded of [first, second]) {
      const after = await derivedRows(seeded);
      expect(after).toEqual(allGone(after));
    }
    expect(await derivedRows(someoneElse)).toEqual(someoneElseBefore);
    expect(await count("visitors WHERE id = $1", [visitorId])).toBe(0);
    const values = await database.query<{ scope_type: string; scope_id: string }>(
      "SELECT scope_type, scope_id FROM context_variable_values WHERE workspace_id = $1 AND scope_type <> 'session' ORDER BY scope_id",
      [tenant.workspaceId],
    );
    expect(values).toEqual([
      { scope_type: "customer", scope_id: "customer-7" },
      { scope_type: "agent", scope_id: tenant.agentId },
    ].sort((a, b) => a.scope_id.localeCompare(b.scope_id)));
    expect(receipt).toMatchObject({ conversationCount: 2, messageCount: 4, rowsByOwner: { "context-variables": 3 } });
    const [event] = await database.query<{ metadata_json: Record<string, unknown> }>(
      "SELECT metadata_json FROM audit_events WHERE workspace_id = $1 AND event_type = 'visitor.erased'",
      [tenant.workspaceId],
    );
    expect(event.metadata_json).toMatchObject({ visitorId, conversationCount: 2, messageCount: 4 });
  });

  it("refuses an unknown visitor", async () => {
    const tenant = await seedTenant();

    await expect(erasure.eraseVisitor({ workspaceId: tenant.workspaceId, visitorId: randomUUID(), actor: actor(tenant) }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("deleting a workspace leaves no conversation state and no turn audit content behind", async () => {
    const tenant = await seedTenant();
    const seeded = await seedConversation(tenant);
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());

    expect(await lifecycle.deleteWorkspace({
      accountId: tenant.accountId,
      workspaceId: tenant.workspaceId,
      auditEvent: { accountId: tenant.accountId, workspaceId: null, eventType: "workspace.deleted", eventStatus: "success", metadata: {} },
    })).toBe(true);

    const after = await derivedRows(seeded);
    expect(after).toEqual(allGone(after));
    // Audit events outlive their workspace with its id cleared; none of them keeps the turn content.
    expect(await count(
      "audit_events WHERE event_type IN ('chat.answer', 'chat.suspended') AND metadata_json->>'conversationId' = $1",
      [seeded.conversationId],
    )).toBe(0);
  });

  it("deleting an account runs the same erasure for each of its workspaces", async () => {
    const tenant = await seedTenant();
    const seeded = await seedConversation(tenant);
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());

    expect(await lifecycle.deleteAccount({
      accountId: tenant.accountId,
      auditEvent: { accountId: tenant.accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
    })).toBe(true);

    const after = await derivedRows(seeded);
    expect(after).toEqual(allGone(after));
  });
});
