import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPostgresConversationErasureUnitOfWork,
  createWorkspaceConversationDataErasure,
} from "../../src/app/composition/conversationErasure.js";
import { createConversationRetentionSweep } from "../../src/app/composition/conversationRetention.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { ConversationErasureService } from "../../src/modules/privacy/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

interface Tenant {
  accountId: string;
  workspaceId: string;
  agentId: string;
}

/**
 * Retention runs on a schedule nobody watches, so these check what it removes against the database
 * itself: what a window passed goes with every copy derived from it, what it has not passed stays,
 * and two sweeps at once, or a sweep run again, remove each row once.
 */
describeIntegration("conversation retention (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const erasure = new ConversationErasureService({
    unitOfWork: createPostgresConversationErasureUnitOfWork({ db: database.kysely, logger }),
    invalidation: { enqueue: vi.fn() },
    auditLog: {},
  });
  const seededAccountIds: string[] = [];

  beforeAll(async () => {
    await runAllTestMigrations(database);
  });

  // Each test's window applies to its own workspace only: an earlier test's workspace would spend
  // the budget a test measures.
  beforeEach(async () => {
    await database.query("UPDATE workspaces SET conversation_retention_days = NULL WHERE conversation_retention_days IS NOT NULL");
  });

  afterAll(async () => {
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());
    for (const accountId of seededAccountIds) {
      await lifecycle.deleteAccount({
        accountId,
        auditEvent: { accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
      });
    }
    await database.close().catch(() => undefined);
  });

  const sweepWith = (budget?: Parameters<typeof createConversationRetentionSweep>[0]["budget"]) => createConversationRetentionSweep({
    db: database.kysely,
    erasure,
    logger,
    metrics: new MetricsRegistry(),
    ...(budget ? { budget } : {}),
  });

  const seedTenant = async (retentionDays: number | null): Promise<Tenant> => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Retention",
      email: `retention-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Retention Workspace");
    await database.query("UPDATE workspaces SET conversation_retention_days = $2 WHERE id = $1", [workspace.id, retentionDays]);
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Support')", [agentId, workspace.id]);
    return { accountId: account.id, workspaceId: workspace.id, agentId };
  };

  /** A conversation last updated `idleDays` ago, with its messages, summary and routine state, and an eval snapshot taken from it. */
  const seedConversation = async (
    tenant: Tenant,
    options: { idleDays: number; messageDaysAgo?: number },
  ): Promise<string> => {
    const conversationId = randomUUID();
    const messageDaysAgo = options.messageDaysAgo ?? options.idleDays;
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, created_at, updated_at)
       VALUES ($1, $2, $3, now() - make_interval(days => $4), now() - make_interval(days => $4))`,
      [conversationId, tenant.workspaceId, tenant.agentId, options.idleDays],
    );
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, created_at) VALUES
         ($1, $3, $4, 'user', 'My knee hurts after class', now() - make_interval(days => $5)),
         ($2, $3, $4, 'assistant', 'Sorry to hear that.', now() - make_interval(days => $5))`,
      [randomUUID(), randomUUID(), conversationId, tenant.workspaceId, messageDaysAgo],
    );
    await database.query(
      `INSERT INTO conversation_summaries (session_id, summary, covered_message_count, covered_through, expires_at)
       VALUES ($1, 'Knee injury', 2, now(), now() + interval '1 day')`,
      [conversationId],
    );
    await database.query(
      `INSERT INTO routine_states (session_id, routine_id, variables, status, expires_at)
       VALUES ($1, 'booking', '{"injury": "knee"}'::jsonb, 'suspended', NULL)`,
      [conversationId],
    );
    await database.query(
      `INSERT INTO eval_snapshots (id, workspace_id, source_conversation_id, fidelity, messages)
       VALUES ($1, $2, $3, 'messages_only', '[{"role": "user", "content": "My knee hurts after class"}]'::jsonb)`,
      [randomUUID(), tenant.workspaceId, conversationId],
    );
    return conversationId;
  };

  const count = async (from: string, params: unknown[]): Promise<number> => {
    const [row] = await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${from}`, params);
    return Number(row.count);
  };

  const copiesOf = async (conversationId: string) => ({
    conversations: await count("conversations WHERE id = $1", [conversationId]),
    messages: await count("messages WHERE conversation_id = $1", [conversationId]),
    conversation_summaries: await count("conversation_summaries WHERE session_id = $1", [conversationId]),
    routine_states: await count("routine_states WHERE session_id = $1", [conversationId]),
    eval_snapshots: await count("eval_snapshots WHERE source_conversation_id = $1", [conversationId]),
  });

  const gone = { conversations: 0, messages: 0, conversation_summaries: 0, routine_states: 0, eval_snapshots: 0 };
  const whole = { conversations: 1, messages: 2, conversation_summaries: 1, routine_states: 1, eval_snapshots: 1 };

  describe("the workspace's conversation window", () => {
    it("erases a conversation the window passed with every derived copy, and keeps one it has not", async () => {
      const tenant = await seedTenant(30);
      const expired = await seedConversation(tenant, { idleDays: 45 });
      const recent = await seedConversation(tenant, { idleDays: 10 });

      const result = await sweepWith().run();

      expect(await copiesOf(expired)).toEqual(gone);
      expect(await copiesOf(recent)).toEqual(whole);
      expect(result.removed.conversations).toBe(1);
      expect(result.removed.messages).toBe(2);
      expect(result.drained).toBe(true);
    });

    it("keeps a conversation whose row is old when a message reached it inside the window", async () => {
      const tenant = await seedTenant(30);
      const revived = await seedConversation(tenant, { idleDays: 45, messageDaysAgo: 2 });

      await sweepWith().run();

      expect(await copiesOf(revived)).toEqual(whole);
    });

    it("deletes nothing in a workspace that has no window, however old its conversations", async () => {
      const tenant = await seedTenant(null);
      const ancient = await seedConversation(tenant, { idleDays: 4_000 });

      await sweepWith().run();

      expect(await copiesOf(ancient)).toEqual(whole);
    });

    it("records one content-free audit event per batch, naming the system and no conversation", async () => {
      const tenant = await seedTenant(30);
      const expired = await seedConversation(tenant, { idleDays: 45 });

      await sweepWith().run();

      const events = await database.query<{ event_type: string; account_id: string; metadata_json: Record<string, unknown> }>(
        "SELECT event_type, account_id, metadata_json FROM audit_events WHERE workspace_id = $1",
        [tenant.workspaceId],
      );
      expect(events).toEqual([{
        event_type: "conversation.retention.enforced",
        account_id: tenant.accountId,
        metadata_json: expect.objectContaining({ principalType: "system", retentionDays: 30, conversationCount: 1, messageCount: 2 }),
      }]);
      expect(JSON.stringify(events)).not.toContain(expired);
    });

    it("drains a backlog over several runs within its budget, and a run after that removes nothing", async () => {
      const tenant = await seedTenant(30);
      const expired = await Promise.all([1, 2, 3, 4, 5].map(() => seedConversation(tenant, { idleDays: 60 })));
      const budget = { conversationBatchSize: 2, maxConversationBatches: 1 };

      const first = await sweepWith(budget).run();
      expect(first.removed.conversations).toBe(2);
      expect(first.drained).toBe(false);
      await sweepWith(budget).run();
      await sweepWith(budget).run();
      const rerun = await sweepWith(budget).run();

      for (const conversationId of expired) {
        expect(await copiesOf(conversationId)).toEqual(gone);
      }
      expect(rerun.removed.conversations ?? 0).toBe(0);
      expect(rerun.drained).toBe(true);
    });

    it("keeps a conversation a message reached after the claim's snapshot, by checking again under the locks", async () => {
      const tenant = await seedTenant(30);
      const conversationId = await seedConversation(tenant, { idleDays: 45 });
      await database.query(
        "INSERT INTO conversation_ownership (conversation_id, workspace_id, state) VALUES ($1, $2, 'ai_owned')",
        [conversationId, tenant.workspaceId],
      );
      // Another unit holds the ownership row, so the erasure stops after its claim locked the
      // conversation, at step 2 of the lock protocol, with the claim's snapshot already taken.
      const holder = await database.pool.connect();
      const writer = await database.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM conversation_ownership WHERE conversation_id = $1 FOR UPDATE", [conversationId]);
        const sweeping = sweepWith().run();
        await expect.poll(async () => {
          const [row] = await database.query<{ waiting: string }>(
            `SELECT count(*)::text AS waiting FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%conversation_ownership%'`,
            [],
          );
          return Number(row.waiting);
        }, { timeout: 10_000 }).toBe(1);
        // A visitor's message commits meanwhile. The claim holds the conversation row, so the message
        // is written without the foreign key's row lock, which would wait for the erasure instead.
        await writer.query("SET session_replication_role = replica");
        await writer.query(
          "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'user', 'I am back')",
          [randomUUID(), conversationId, tenant.workspaceId],
        );
        await writer.query("SET session_replication_role = origin");
        await holder.query("COMMIT");

        const result = await sweeping;

        expect(result.removed.conversations ?? 0).toBe(0);
        expect(await copiesOf(conversationId)).toEqual({ ...whole, messages: 3 });
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
        writer.release();
      }
    });

    it("lets two sweeps run at once, each conversation erased by exactly one of them", async () => {
      const tenant = await seedTenant(30);
      const expired = await Promise.all(Array.from({ length: 8 }, () => seedConversation(tenant, { idleDays: 60 })));
      const budget = { conversationBatchSize: 2, maxConversationBatches: 10 };

      const [left, right] = await Promise.all([sweepWith(budget).run(), sweepWith(budget).run()]);

      expect((left.removed.conversations ?? 0) + (right.removed.conversations ?? 0)).toBe(8);
      expect(left.failed + right.failed).toBe(0);
      for (const conversationId of expired) {
        expect(await copiesOf(conversationId)).toEqual(gone);
      }
      const recorded = await database.query<{ total: string }>(
        `SELECT coalesce(sum((metadata_json->>'conversationCount')::int), 0)::text AS total
         FROM audit_events WHERE workspace_id = $1 AND event_type = 'conversation.retention.enforced'`,
        [tenant.workspaceId],
      );
      expect(Number(recorded[0].total)).toBe(8);
    });
  });

  describe("the fixed windows", () => {
    it("deletes summaries and routine states past their expiry, and keeps the ones before it", async () => {
      const tenant = await seedTenant(null);
      const conversationId = await seedConversation(tenant, { idleDays: 0 });
      const other = await seedConversation(tenant, { idleDays: 0 });
      await database.query("UPDATE conversation_summaries SET expires_at = now() - interval '1 minute' WHERE session_id = $1", [conversationId]);
      await database.query(
        "UPDATE routine_states SET status = 'active', expires_at = now() - interval '1 minute' WHERE session_id = $1",
        [conversationId],
      );
      await database.query("UPDATE routine_states SET status = 'active', expires_at = now() + interval '30 minutes' WHERE session_id = $1", [other]);

      const result = await sweepWith().run();

      expect(await count("conversation_summaries WHERE session_id = $1", [conversationId])).toBe(0);
      expect(await count("routine_states WHERE session_id = $1", [conversationId])).toBe(0);
      expect(await count("conversation_summaries WHERE session_id = $1", [other])).toBe(1);
      expect(await count("routine_states WHERE session_id = $1", [other])).toBe(1);
      expect(await count("conversations WHERE id = $1", [conversationId])).toBe(1);
      expect(result.removed.conversation_summaries).toBeGreaterThanOrEqual(1);
      expect(result.removed.routine_states).toBeGreaterThanOrEqual(1);
    });

    it("deletes a routine state left 90 days without an update, never while its conversation had activity inside them", async () => {
      const tenant = await seedTenant(null);
      const abandoned = await seedConversation(tenant, { idleDays: 120 });
      const stillTalking = await seedConversation(tenant, { idleDays: 120, messageDaysAgo: 5 });
      const recentlyWaiting = await seedConversation(tenant, { idleDays: 120 });
      await database.query(
        "UPDATE routine_states SET updated_at = now() - interval '100 days' WHERE session_id = ANY($1::uuid[])",
        [[abandoned, stillTalking]],
      );
      await database.query("UPDATE routine_states SET updated_at = now() - interval '20 days' WHERE session_id = $1", [recentlyWaiting]);

      await sweepWith().run();

      expect(await count("routine_states WHERE session_id = $1", [abandoned])).toBe(0);
      expect(await count("routine_states WHERE session_id = $1", [stillTalking])).toBe(1);
      expect(await count("routine_states WHERE session_id = $1", [recentlyWaiting])).toBe(1);
      expect(await count("conversations WHERE id = $1", [abandoned])).toBe(1);
    });

    it("clears the raw copy of inbound mail after 30 days and keeps the delivery's threading facts", async () => {
      const tenant = await seedTenant(null);
      const conversationId = await seedConversation(tenant, { idleDays: 0 });
      const deliveryOf = async (state: string, daysAgo: number): Promise<string> => {
        const [event] = await database.query<{ id: string }>(
          `INSERT INTO email_inbound_events (provider, provider_event_id, event_kind, envelope, state)
           VALUES ('local', $1, 'message_received', '{}'::jsonb, 'processed') RETURNING id`,
          [`evt-${randomUUID()}`],
        );
        const [delivery] = await database.query<{ id: string }>(
          `INSERT INTO email_inbound_deliveries
             (inbound_event_id, workspace_id, state, sender_address, rfc_message_id, body_text, raw_mime, raw_size_bytes, conversation_id, created_at)
           VALUES ($1, $2, $3, 'jane@example.com', $4, 'My knee hurts', convert_to('MIME', 'UTF8'), 4, $5, now() - make_interval(days => $6))
           RETURNING id`,
          [event.id, tenant.workspaceId, state, `<${randomUUID()}@example.com>`, conversationId, daysAgo],
        );
        return delivery.id;
      };
      const old = await deliveryOf("done", 31);
      const recent = await deliveryOf("done", 29);
      const unfinished = await deliveryOf("fetched", 31);

      const result = await sweepWith().run();

      const rows = await database.query<{ id: string; has_raw: boolean; rfc_message_id: string | null; raw_size_bytes: number | null }>(
        "SELECT id, raw_mime IS NOT NULL AS has_raw, rfc_message_id, raw_size_bytes FROM email_inbound_deliveries WHERE id = ANY($1::uuid[])",
        [[old, recent, unfinished]],
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(old)).toMatchObject({ has_raw: false, rfc_message_id: expect.any(String), raw_size_bytes: 4 });
      expect(byId.get(recent)?.has_raw).toBe(true);
      expect(byId.get(unfinished)?.has_raw).toBe(true);
      expect(result.removed["email_inbound_deliveries.raw_mime"]).toBeGreaterThanOrEqual(1);
    });

    it("removes each expired row once when two sweeps run at once", async () => {
      const tenant = await seedTenant(null);
      const conversations = await Promise.all(Array.from({ length: 6 }, () => seedConversation(tenant, { idleDays: 0 })));
      await database.query(
        "UPDATE conversation_summaries SET expires_at = now() - interval '1 minute' WHERE session_id = ANY($1::uuid[])",
        [conversations],
      );
      const budget = { ruleBatchSize: 2, maxRuleBatches: 10 };

      await Promise.all([sweepWith(budget).run(), sweepWith(budget).run()]);

      expect(await count("conversation_summaries WHERE session_id = ANY($1::uuid[])", [conversations])).toBe(0);
    });

    /** The database's own clock, so a summary a prior test run left behind never counts as this test's. */
    const databaseNow = async (): Promise<string> => (await database.query<{ now: string }>("SELECT now()::text AS now", []))[0].now;

    const summaryEventsSince = (marker: string) =>
      database.query<{ account_id: string | null; workspace_id: string | null; metadata_json: Record<string, unknown> }>(
        "SELECT account_id, workspace_id, metadata_json FROM audit_events WHERE event_type = 'audit_event.retention.enforced' AND created_at >= $1",
        [marker],
      );

    it("deletes audit events older than the retention window, orphaned or not, keeps recent ones, and records one summary event for the run", async () => {
      const tenant = await seedTenant(null);
      const marker = await databaseNow();
      const seedAuditEvent = async (daysAgo: number, workspaceId: string | null): Promise<string> => {
        const id = randomUUID();
        await database.query(
          `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json, created_at)
           VALUES ($1, $2, $3, 'workspace.privacy_settings.updated', 'success', '{}'::jsonb, now() - make_interval(days => $4))`,
          [id, tenant.accountId, workspaceId, daysAgo],
        );
        return id;
      };
      const oldWithWorkspace = await seedAuditEvent(400, tenant.workspaceId);
      const oldOrphaned = await seedAuditEvent(400, null);
      const recentWithWorkspace = await seedAuditEvent(10, tenant.workspaceId);
      const recentOrphaned = await seedAuditEvent(10, null);

      await sweepWith().run();

      const remaining = await database.query<{ id: string }>(
        "SELECT id FROM audit_events WHERE id = ANY($1::uuid[])",
        [[oldWithWorkspace, oldOrphaned, recentWithWorkspace, recentOrphaned]],
      );
      expect(remaining.map((row) => row.id).sort()).toEqual([recentOrphaned, recentWithWorkspace].sort());

      const summaries = await summaryEventsSince(marker);
      expect(summaries).toEqual([{
        account_id: null,
        workspace_id: null,
        metadata_json: expect.objectContaining({ deletedCount: 2, windowDays: 365, principalType: "system" }),
      }]);
      expect(JSON.stringify(summaries)).not.toContain(oldWithWorkspace);
      expect(JSON.stringify(summaries)).not.toContain(oldOrphaned);
    });

    it("records no summary event for a run that finds nothing past the audit event window", async () => {
      const tenant = await seedTenant(null);
      const marker = await databaseNow();
      await database.query(
        `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json, created_at)
         VALUES ($1, $2, $3, 'workspace.privacy_settings.updated', 'success', '{}'::jsonb, now() - interval '10 days')`,
        [randomUUID(), tenant.accountId, tenant.workspaceId],
      );

      await sweepWith().run();

      expect(await summaryEventsSince(marker)).toEqual([]);
    });
  });
});
