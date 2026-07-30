import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { QualityTurnsService } from "../../src/modules/quality/service.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { stubOutcomeCatalog } from "../support/qualityOutcomeCatalog.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
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

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;
const clock = () => new Date("2026-07-30T12:00:00.000Z");

describeIfDatabase("quality resolution reporting", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  it("keeps breakdown and reason-filtered rows in parity across reopen and legacy history", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const [knowledgeGapId, dismissedId, legacyId, reopenedId, oldId] = Array.from(
      { length: 5 },
      () => randomUUID(),
    );
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Reporting', $2, 'hash')",
      [accountId, `quality-reporting-${accountId}@example.com`],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Reporting', $3)",
      [workspaceId, accountId, `quality-reporting-${workspaceId}`],
    );
    await database.query(
      "INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Reporting agent')",
      [agentId, workspaceId],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $2, $3, 'embed')`,
      [conversationId, workspaceId, agentId],
    );
    await database.query(
      `INSERT INTO messages
         (id, conversation_id, workspace_id, role, content, skill_name, skill_outcome, skill_status, created_at)
       SELECT
         source.id,
         $6,
         $7,
         'assistant',
         source.content,
         'retrieval.answer',
         'no_context',
         'completed',
         '2026-06-01T00:00:00Z'
       FROM (VALUES
         ($1::uuid, 'knowledge'),
         ($2::uuid, 'dismissed'),
         ($3::uuid, 'legacy'),
         ($4::uuid, 'reopened'),
         ($5::uuid, 'old')
       ) AS source(id, content)`,
      [
        knowledgeGapId,
        dismissedId,
        legacyId,
        reopenedId,
        oldId,
        conversationId,
        workspaceId,
      ],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog(), clock);
    await service.setTriageState(workspaceId, {
      assistantMessageId: knowledgeGapId,
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "knowledge_gap", note: null },
    });
    await service.setTriageState(workspaceId, {
      assistantMessageId: dismissedId,
      state: "dismissed",
      expectedVersion: 0,
      resolution: { reason: "expected_behavior", note: null },
    });
    await service.setTriageState(workspaceId, {
      assistantMessageId: legacyId,
      state: "resolved",
      expectedVersion: 0,
      legacyReason: "Old client text",
    });
    await service.setTriageState(workspaceId, {
      assistantMessageId: reopenedId,
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "platform_bug", note: null },
    });
    await service.setTriageState(workspaceId, {
      assistantMessageId: reopenedId,
      state: "open",
      expectedVersion: 1,
    });
    await service.setTriageState(workspaceId, {
      assistantMessageId: oldId,
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "knowledge_gap", note: null },
    });
    await database.query(
      `UPDATE assistant_answer_triage
       SET closed_at = CASE
         WHEN assistant_message_id = $1 THEN '2026-07-01T00:00:00Z'::timestamptz
         ELSE '2026-07-29T00:00:00Z'::timestamptz
       END
       WHERE workspace_id = $2
         AND state IN ('resolved', 'dismissed')`,
      [oldId, workspaceId],
    );
    await database.query(
      `INSERT INTO assistant_answer_feedback (
         id,
         workspace_id,
         conversation_id,
         assistant_message_id,
         actor_type,
         actor_id,
         value,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, 'authenticated_user', 'new-reviewer', 'down', $5, $5)`,
      [
        randomUUID(),
        workspaceId,
        conversationId,
        knowledgeGapId,
        "2026-07-31T00:00:00.000Z",
      ],
    );

    const stats = await service.getQualityStats(workspaceId, {
      range: "7d",
      agentId,
      channel: "embed",
    });
    expect(stats.resolutionBreakdown).toEqual([
      { state: "dismissed", reason: "expected_behavior", count: 1 },
      { state: "resolved", reason: "unspecified", count: 1 },
    ]);
    expect(stats.backlog.negative_feedback).toBe(1);

    const knowledgeRows = await service.listLowQualityTurns(workspaceId, {
      triageStates: ["resolved"],
      resolutionReasons: ["knowledge_gap"],
      resolutionFrom: "2026-07-24T00:00:00.000Z",
      resolutionTo: "2026-07-31T00:00:00.000Z",
      agentId,
      channel: "embed",
      limit: 25,
    });
    expect(knowledgeRows.items).toHaveLength(0);
    expect(knowledgeRows.total).toBe(0);

    const unspecifiedRows = await service.listLowQualityTurns(workspaceId, {
      triageStates: ["resolved"],
      resolutionReasons: ["unspecified"],
      resolutionFrom: "2026-07-24T00:00:00.000Z",
      resolutionTo: "2026-07-31T00:00:00.000Z",
      limit: 25,
    });
    expect(unspecifiedRows.items.map((item) => item.assistantMessageId)).toEqual([legacyId]);
  });
});
