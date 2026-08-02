import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { QualityContentPlanningEvidenceSource } from "../../src/modules/quality/contentPlanningEvidence.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) return false;
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const isolatedUrl = (base: string, name: string): string => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

describeIfDatabase("content planning Quality evidence integration", () => {
  const databaseName = `content_planning_quality_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin
      ?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("reuses the canonical population, effective triage, grounding snapshots, and member mapping", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Content Quality", `content-quality-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Content Quality", `cq-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      "INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)",
      [agentId, workspaceId, "Quality Bot"],
    );

    const endUserConversationId = randomUUID();
    const operatorTestConversationId = randomUUID();
    await database.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
       VALUES ($1, $3, $4, 'embed'), ($2, $3, $4, 'authenticated_chat')`,
      [endUserConversationId, operatorTestConversationId, workspaceId, agentId],
    );

    const userMessageId = randomUUID();
    const gapMessageId = randomUUID();
    const humanMessageId = randomUUID();
    const operatorTestMessageId = randomUUID();
    await database.query(
      `INSERT INTO messages (
         id, conversation_id, workspace_id, role, content, source,
         grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count, created_at
       ) VALUES
         ($1, $5, $7, 'user', 'How do refunds work?', NULL, NULL, NULL, NULL, NULL, NULL, $8),
         ($2, $5, $7, 'assistant', 'Unsupported answer', NULL, 'no_support', 1, 0, 1, 0, $9),
         ($3, $5, $7, 'assistant', 'Human answer', 'human_agent', NULL, NULL, NULL, NULL, NULL, $10),
         ($4, $6, $7, 'assistant', 'Test answer', NULL, NULL, NULL, NULL, NULL, NULL, $11)`,
      [
        userMessageId,
        gapMessageId,
        humanMessageId,
        operatorTestMessageId,
        endUserConversationId,
        operatorTestConversationId,
        workspaceId,
        "2026-07-15T10:00:00.000Z",
        "2026-07-15T10:00:01.000Z",
        "2026-07-15T10:00:02.000Z",
        "2026-07-15T10:00:03.000Z",
      ],
    );
    await database.query(
      `INSERT INTO assistant_answer_triage (
         workspace_id, assistant_message_id, state, version, resolution_reason, closed_at, updated_at
       ) VALUES ($1, $2, 'resolved', 1, 'knowledge_gap', $3, $3)`,
      [workspaceId, gapMessageId, "2026-07-15T10:01:00.000Z"],
    );
    await database.query(
      `INSERT INTO assistant_answer_feedback (
         id, workspace_id, conversation_id, assistant_message_id,
         actor_type, actor_id, value, comment, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'authenticated_user', 'operator', 'down', 'Still broken', $5, $5)`,
      [randomUUID(), workspaceId, endUserConversationId, gapMessageId, "2026-07-15T10:02:00.000Z"],
    );

    const source = new QualityContentPlanningEvidenceSource(database.kysely);
    const population = await source.listPopulationPage(workspaceId, {
      window: { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
      limit: 1,
    });
    expect(population.items).toEqual([expect.objectContaining({
      assistantMessageId: gapMessageId,
      userMessageId,
    })]);
    expect(population.nextCursor).toBeNull();

    const evidence = await source.getEvidenceByAssistantMessageIds(workspaceId, [
      gapMessageId,
      humanMessageId,
      operatorTestMessageId,
    ]);
    expect([...evidence.keys()]).toEqual([gapMessageId]);
    expect(evidence.get(gapMessageId)).toMatchObject({
      grounding: { verdict: "no_support", claimCount: 1 },
      triage: {
        state: "open",
        resolutionReason: null,
        reopenedByNewerNegativeFeedback: true,
      },
      remediation: { active: true, inactiveReasons: [] },
    });

    const memberPage = await source.mapMemberTurnPage(workspaceId, {
      assistantMessageIds: [gapMessageId, humanMessageId, operatorTestMessageId],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    expect(memberPage.items).toHaveLength(1);
    expect(memberPage.items[0]).toMatchObject({
      assistantMessageId: gapMessageId,
      question: "How do refunds work?",
      answerPreview: "Unsupported answer",
      triage: { state: "open", resolution: null },
    });
  });
});
