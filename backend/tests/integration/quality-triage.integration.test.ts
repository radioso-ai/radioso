import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import { QualityTurnsService } from "../../src/modules/quality/service.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { unrecordedConversationActivity } from "../support/fakes.js";
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

describeIfDatabase("quality triage transitions", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  const seedTurn = async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const conversationId = randomUUID();
    const assistantMessageId = randomUUID();
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Quality', $2, 'hash')",
      [accountId, `quality-triage-${accountId}@example.com`],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Quality', $3)",
      [workspaceId, accountId, `quality-${workspaceId}`],
    );
    await database.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')",
      [userId, `quality-triage-user-${userId}@example.com`],
    );
    await database.query(
      "INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'embed')",
      [conversationId, workspaceId],
    );
    await database.query(
      `INSERT INTO messages
         (id, conversation_id, workspace_id, role, content, skill_name, skill_outcome, skill_status)
       VALUES ($1, $2, $3, 'assistant', 'Answer', 'retrieval.answer', 'no_context', 'completed')`,
      [assistantMessageId, conversationId, workspaceId],
    );
    return { workspaceId, userId, conversationId, assistantMessageId };
  };

  it("treats a missing triage row as open version zero", async () => {
    const fixture = await seedTurn();
    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog(), unrecordedConversationActivity);

    const page = await service.listLowQualityTurns(fixture.workspaceId, { limit: 25 });

    expect(page.items[0]?.triage).toEqual({
      state: "open",
      version: 0,
      resolution: null,
      legacyReason: null,
      closedAt: null,
      updatedAt: null,
    });
  });

  it("atomically records close, reopen, and reclose transitions without the note", async () => {
    const fixture = await seedTurn();
    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog(), unrecordedConversationActivity);

    const closed = await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "knowledge_gap", note: "Updated the refund policy" },
      updatedBy: fixture.userId,
    });
    expect(closed).toMatchObject({
      kind: "updated",
      record: {
        state: "resolved",
        version: 1,
        resolution: { reason: "knowledge_gap", note: "Updated the refund policy" },
        legacyReason: null,
      },
    });

    const reopened = await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "open",
      expectedVersion: 1,
      updatedBy: fixture.userId,
    });
    expect(reopened).toMatchObject({
      kind: "updated",
      record: {
        state: "open",
        version: 2,
        resolution: null,
        legacyReason: null,
        closedAt: null,
      },
    });

    const reclosed = await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "dismissed",
      expectedVersion: 2,
      resolution: { reason: "expected_behavior", note: null },
      updatedBy: fixture.userId,
    });
    expect(reclosed).toMatchObject({
      kind: "updated",
      record: {
        state: "dismissed",
        version: 3,
        resolution: { reason: "expected_behavior", note: null },
      },
    });

    const transitions = await database.query<{
      prior_state: string;
      next_state: string;
      resulting_version: number;
      resolution_reason: string | null;
    }>(
      `SELECT prior_state, next_state, resulting_version, resolution_reason
       FROM assistant_answer_triage_transitions
       WHERE workspace_id = $1 AND assistant_message_id = $2
       ORDER BY resulting_version`,
      [fixture.workspaceId, fixture.assistantMessageId],
    );
    expect(transitions).toEqual([
      {
        prior_state: "open",
        next_state: "resolved",
        resulting_version: 1,
        resolution_reason: "knowledge_gap",
      },
      {
        prior_state: "resolved",
        next_state: "open",
        resulting_version: 2,
        resolution_reason: null,
      },
      {
        prior_state: "open",
        next_state: "dismissed",
        resulting_version: 3,
        resolution_reason: "expected_behavior",
      },
    ]);
  });

  it("snapshots linked Eval identity in audit history after the mutable case is deleted", async () => {
    const fixture = await seedTurn();
    const snapshotId = randomUUID();
    const caseId = randomUUID();

    await database.query(
      `INSERT INTO eval_snapshots (
         id, workspace_id, source_conversation_id, source_message_id, fidelity, messages
       )
       VALUES ($1, $2, $3, $4, 'messages_only', '[]'::jsonb)`,
      [
        snapshotId,
        fixture.workspaceId,
        fixture.conversationId,
        fixture.assistantMessageId,
      ],
    );
    await database.query(
      `INSERT INTO eval_cases (id, workspace_id, snapshot_id, name, status)
       VALUES ($1, $2, $3, 'Quality audit case', 'pending')`,
      [caseId, fixture.workspaceId, snapshotId],
    );
    await database.query(
      `INSERT INTO eval_message_case_associations (
         workspace_id, assistant_message_id, case_id
       )
       VALUES ($1, $2, $3)`,
      [fixture.workspaceId, fixture.assistantMessageId, caseId],
    );

    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog(), unrecordedConversationActivity);
    await expect(service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "knowledge_gap", note: null },
      updatedBy: fixture.userId,
    })).resolves.toMatchObject({ kind: "updated" });

    const loadLinkedCaseIds = () => database.query<{ linked_eval_case_id: string | null }>(
      `SELECT linked_eval_case_id
       FROM assistant_answer_triage_transitions
       WHERE workspace_id = $1 AND assistant_message_id = $2`,
      [fixture.workspaceId, fixture.assistantMessageId],
    );
    await expect(loadLinkedCaseIds()).resolves.toEqual([{ linked_eval_case_id: caseId }]);

    await database.query("DELETE FROM eval_cases WHERE id = $1", [caseId]);

    await expect(database.query(
      "SELECT 1 FROM eval_message_case_associations WHERE case_id = $1",
      [caseId],
    )).resolves.toHaveLength(0);
    await expect(loadLinkedCaseIds()).resolves.toEqual([{ linked_eval_case_id: caseId }]);
  });

  it("allows one concurrent first write and returns the winner to the stale caller", async () => {
    const fixture = await seedTurn();
    const firstService = new QualityTurnsService(database.kysely, stubOutcomeCatalog(), unrecordedConversationActivity);
    const secondService = new QualityTurnsService(database.kysely, stubOutcomeCatalog(), unrecordedConversationActivity);

    const results = await Promise.all([
      firstService.setTriageState(fixture.workspaceId, {
        assistantMessageId: fixture.assistantMessageId,
        state: "acknowledged",
        expectedVersion: 0,
        updatedBy: fixture.userId,
      }),
      secondService.setTriageState(fixture.workspaceId, {
        assistantMessageId: fixture.assistantMessageId,
        state: "resolved",
        expectedVersion: 0,
        resolution: { reason: "retrieval_issue", note: null },
        updatedBy: fixture.userId,
      }),
    ]);

    expect(results.filter((result) => result.kind === "updated")).toHaveLength(1);
    const conflict = results.find((result) => result.kind === "conflict");
    expect(conflict).toMatchObject({
      kind: "conflict",
      current: { version: 1 },
    });
    const transitions = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM assistant_answer_triage_transitions
       WHERE workspace_id = $1 AND assistant_message_id = $2`,
      [fixture.workspaceId, fixture.assistantMessageId],
    );
    expect(transitions[0]?.count).toBe("1");
  });

  it("rejects a stale later write without changing current state or audit history", async () => {
    const fixture = await seedTurn();
    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog(), unrecordedConversationActivity);
    await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "acknowledged",
      expectedVersion: 0,
      updatedBy: fixture.userId,
    });

    const conflict = await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "platform_bug", note: null },
      updatedBy: fixture.userId,
    });

    expect(conflict).toMatchObject({
      kind: "conflict",
      current: {
        state: "acknowledged",
        version: 1,
        resolution: null,
      },
    });
    const transitions = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM assistant_answer_triage_transitions
       WHERE workspace_id = $1 AND assistant_message_id = $2`,
      [fixture.workspaceId, fixture.assistantMessageId],
    );
    expect(transitions[0]?.count).toBe("1");
  });

  it("returns effective-open conflict state and records effective-open audit history after fresh feedback", async () => {
    const fixture = await seedTurn();
    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog(), unrecordedConversationActivity);
    await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "knowledge_gap", note: "Closed before later feedback" },
      updatedBy: fixture.userId,
    });
    await database.query(
      `UPDATE assistant_answer_triage
       SET closed_at = '2026-07-29T10:00:00Z', updated_at = '2026-07-29T10:00:00Z'
       WHERE workspace_id = $1 AND assistant_message_id = $2`,
      [fixture.workspaceId, fixture.assistantMessageId],
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
       VALUES ($1, $2, $3, $4, 'authenticated_user', 'later-reviewer', 'down', $5, $5)`,
      [
        randomUUID(),
        fixture.workspaceId,
        fixture.conversationId,
        fixture.assistantMessageId,
        "2026-07-30T10:00:00.000Z",
      ],
    );

    const conflict = await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "dismissed",
      expectedVersion: 0,
      resolution: { reason: "expected_behavior", note: null },
      updatedBy: fixture.userId,
    });
    expect(conflict).toEqual({
      kind: "conflict",
      current: {
        state: "open",
        version: 1,
        resolution: null,
        legacyReason: null,
        closedAt: null,
        updatedAt: null,
      },
    });

    await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "dismissed",
      expectedVersion: 1,
      resolution: { reason: "expected_behavior", note: null },
      updatedBy: fixture.userId,
    });
    const transition = await database.query<{ prior_state: string }>(
      `SELECT prior_state
       FROM assistant_answer_triage_transitions
       WHERE workspace_id = $1
         AND assistant_message_id = $2
         AND resulting_version = 2`,
      [fixture.workspaceId, fixture.assistantMessageId],
    );
    expect(transition).toEqual([{ prior_state: "open" }]);
  });

  it("returns not_found for a missing or foreign assistant turn", async () => {
    const fixture = await seedTurn();
    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog(), unrecordedConversationActivity);
    await expect(service.setTriageState(fixture.workspaceId, {
      assistantMessageId: randomUUID(),
      state: "acknowledged",
      expectedVersion: 0,
      updatedBy: fixture.userId,
    })).resolves.toEqual({ kind: "not_found" });
  });

  const activityOf = async (conversationId: string) => database.query<{
    kind: string;
    actor_user_id: string | null;
    detail: Record<string, unknown>;
  }>(
    "SELECT kind, actor_user_id, detail FROM conversation_activity WHERE conversation_id = $1 ORDER BY created_at",
    [conversationId],
  );

  /** The triage transitions this message recorded, oldest first — how the test learns the ids the
   * live writer is expected to have copied into each closing activity row's detail. */
  const transitionsOf = (assistantMessageId: string) => database.query<{ id: string; next_state: string }>(
    "SELECT id, next_state FROM assistant_answer_triage_transitions WHERE assistant_message_id = $1 ORDER BY created_at",
    [assistantMessageId],
  );

  it("records who resolved and who dismissed the feedback, and nothing for other transitions", async () => {
    const fixture = await seedTurn();
    const service = new QualityTurnsService(
      database.kysely,
      stubOutcomeCatalog(),
      new ConversationActivityRepository(database.kysely),
    );

    await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "acknowledged",
      expectedVersion: 0,
      updatedBy: fixture.userId,
    });
    await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "resolved",
      expectedVersion: 1,
      resolution: { reason: "knowledge_gap", note: "Updated the refund policy" },
      updatedBy: fixture.userId,
    });
    await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "open",
      expectedVersion: 2,
      updatedBy: fixture.userId,
    });
    await service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "dismissed",
      expectedVersion: 3,
      updatedBy: null,
    });

    const transitions = await transitionsOf(fixture.assistantMessageId);
    const resolvedTransitionId = transitions.find((t) => t.next_state === "resolved")?.id;
    const dismissedTransitionId = transitions.find((t) => t.next_state === "dismissed")?.id;

    await expect(activityOf(fixture.conversationId)).resolves.toEqual([
      {
        kind: "feedback_resolved",
        actor_user_id: fixture.userId,
        detail: {
          assistantMessageId: fixture.assistantMessageId,
          triageTransitionId: resolvedTransitionId,
          resolution: "knowledge_gap",
        },
      },
      {
        kind: "feedback_dismissed",
        actor_user_id: null,
        detail: {
          assistantMessageId: fixture.assistantMessageId,
          triageTransitionId: dismissedTransitionId,
          resolution: null,
        },
      },
    ]);
  });

  it("records nothing more when a closed state is saved again", async () => {
    const fixture = await seedTurn();
    const service = new QualityTurnsService(
      database.kysely,
      stubOutcomeCatalog(),
      new ConversationActivityRepository(database.kysely),
    );
    const save = (
      state: "resolved" | "dismissed",
      expectedVersion: number,
      reason: "knowledge_gap" | "out_of_scope" | "other",
    ) =>
      service.setTriageState(fixture.workspaceId, {
        assistantMessageId: fixture.assistantMessageId,
        state,
        expectedVersion,
        resolution: { reason, note: `Saved at version ${expectedVersion}` },
        updatedBy: fixture.userId,
      });

    await expect(save("resolved", 0, "knowledge_gap")).resolves.toMatchObject({ kind: "updated" });
    await expect(save("resolved", 1, "other")).resolves.toMatchObject({ kind: "updated" });
    await expect(save("dismissed", 2, "out_of_scope")).resolves.toMatchObject({ kind: "updated" });
    await expect(save("dismissed", 3, "other")).resolves.toMatchObject({ kind: "updated" });

    const transitions = await transitionsOf(fixture.assistantMessageId);
    const firstResolvedTransitionId = transitions.find((t) => t.next_state === "resolved")?.id;
    const firstDismissedTransitionId = transitions.find((t) => t.next_state === "dismissed")?.id;

    await expect(activityOf(fixture.conversationId)).resolves.toEqual([
      expect.objectContaining({
        kind: "feedback_resolved",
        detail: expect.objectContaining({ resolution: "knowledge_gap", triageTransitionId: firstResolvedTransitionId }),
      }),
      expect.objectContaining({
        kind: "feedback_dismissed",
        detail: expect.objectContaining({ resolution: "out_of_scope", triageTransitionId: firstDismissedTransitionId }),
      }),
    ]);
  });

  it("leaves the feedback open, with no transition, when its closing activity cannot be recorded", async () => {
    const fixture = await seedTurn();
    const service = new QualityTurnsService(database.kysely, stubOutcomeCatalog(), {
      record: async () => { throw new Error("activity unavailable"); },
    });

    await expect(service.setTriageState(fixture.workspaceId, {
      assistantMessageId: fixture.assistantMessageId,
      state: "resolved",
      expectedVersion: 0,
      updatedBy: fixture.userId,
    })).rejects.toThrow("activity unavailable");

    const triage = await database.query(
      "SELECT state FROM assistant_answer_triage WHERE assistant_message_id = $1",
      [fixture.assistantMessageId],
    );
    const transitions = await database.query(
      "SELECT id FROM assistant_answer_triage_transitions WHERE assistant_message_id = $1",
      [fixture.assistantMessageId],
    );
    expect(triage).toEqual([]);
    expect(transitions).toEqual([]);
    await expect(activityOf(fixture.conversationId)).resolves.toEqual([]);
  });
});
