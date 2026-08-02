import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ContentPlanObservationRepository } from "../../src/db/repositories/contentPlanningObservationRepository.js";
import { ContentPlanningCommittedTurnWriter } from "../../src/app/composition/adapters/contentPlanningCommittedTurnWriter.js";
import { PostgresAssistantTurnPersistence } from "../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import type {
  CommittedAssistantTurnObservation,
  CommittedAssistantTurnObservationWriter,
} from "../../src/modules/chat/services/chatTurnLifecycle.js";
import {
  MAX_CONTENT_PLAN_TURN_CONTRIBUTIONS,
  type ContentPlanTurnRegistration,
  type ContentPlanTurnRegistrationResult,
} from "../../src/modules/contentPlanning/contracts/persistence.js";
import { Database } from "../../src/shared/infra/database.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

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

const isolatedUrl = (base: string, name: string): string => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

interface IntakeFixture {
  accountId: string;
  workspaceId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  generationId: string;
  embeddingSpaceId: string;
}

describeIfDatabase("content-planning transactional turn intake", () => {
  const databaseName = `content_plan_intake_${randomUUID().replaceAll("-", "")}`;
  let admin: Database;
  let database: Database;
  let observations: ContentPlanObservationRepository;

  const createFixture = async (suffix: string): Promise<IntakeFixture> => {
    const fixture: IntakeFixture = {
      accountId: randomUUID(),
      workspaceId: randomUUID(),
      conversationId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      generationId: randomUUID(),
      embeddingSpaceId: randomUUID(),
    };
    await database.execute(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, 'hash')",
      [fixture.accountId, `Intake ${suffix}`, `content-plan-intake-${suffix}-${fixture.accountId}@example.com`],
    );
    await database.execute(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4)`,
      [fixture.workspaceId, fixture.accountId, `Workspace ${suffix}`, `intake-${suffix}-${fixture.workspaceId}`],
    );
    await database.execute(
      "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
      [fixture.conversationId, fixture.workspaceId],
    );
    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content)
       VALUES ($1, $2, $3, 'user', 'How can I configure deployment?')`,
      [fixture.userMessageId, fixture.conversationId, fixture.workspaceId],
    );
    await database.execute(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization
       ) VALUES ($1, $2, 'test', $3, 'intake-model', 3, 'cosine', 'unit')`,
      [
        fixture.embeddingSpaceId,
        `content-plan-intake-space-${fixture.embeddingSpaceId}`,
        `content-plan-intake-endpoint-${fixture.embeddingSpaceId}`,
      ],
    );
    await database.execute(
      `INSERT INTO content_plan_projection_generations (
         id, workspace_id, embedding_space_id, kind, state, policy_version,
         horizon_from, horizon_to, coherent_at
       ) VALUES (
         $1, $2, $3, 'active', 'coherent', 1,
         '2026-06-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
       )`,
      [fixture.generationId, fixture.workspaceId, fixture.embeddingSpaceId],
    );
    return fixture;
  };

  const registrationFor = (
    input: CommittedAssistantTurnObservation,
    fixture: IntakeFixture,
  ): ContentPlanTurnRegistration => {
    const vectors = new Map(input.semanticVectors.map((vector) => [vector.intentId, vector]));
    return {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sourceUserMessageId: input.sourceUserMessageId,
      sourceAssistantMessageId: input.sourceAssistantMessageId,
      interactionRole: input.interaction.role,
      contributions: input.interaction.semanticIntents.map((intent) => {
        const vector = vectors.get(intent.id);
        return {
          semanticIntentId: intent.id,
          semanticTextHash: vector?.semanticTextHash
            ?? createHash("sha256").update(intent.text, "utf8").digest("hex"),
          observationState: "ready" as const,
          vectorWork: {
            generationId: fixture.generationId,
            embeddingSpaceId: vector?.space.id ?? fixture.embeddingSpaceId,
            dimensions: vector?.space.dimensions,
            embedding: vector?.vector,
            vectorSource: vector ? "reused" as const : undefined,
          },
        };
      }),
    };
  };

  const committedObservationFor = (
    fixture: IntakeFixture,
    semanticIntents: Array<{ id: string; text: string }> = [
      { id: "primary", text: "configure a deployment" },
    ],
  ): CommittedAssistantTurnObservation => ({
    workspaceId: fixture.workspaceId,
    conversationId: fixture.conversationId,
    agentId: randomUUID(),
    currentUserMessageId: fixture.userMessageId,
    sourceUserMessageId: fixture.userMessageId,
    sourceAssistantMessageId: fixture.assistantMessageId,
    interaction: { role: "substantive_new", semanticIntents },
    semanticVectors: semanticIntents.map((intent, index) => ({
      intentId: intent.id,
      semanticTextHash: createHash("sha256").update(intent.text, "utf8").digest("hex"),
      vector: [1, index / 10, 0],
      space: {
        id: fixture.embeddingSpaceId,
        dimensions: 3,
        distanceMetric: "cosine",
      },
    })),
    grounding: {
      verdict: "degraded",
      claimCount: 2,
      sourcedClaimCount: 1,
      unsourcedClaimCount: 1,
      invalidSourceCount: 0,
    },
  });

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    database = new Database(isolatedUrl(integrationDatabaseUrl!, databaseName));
    await runAllTestMigrations(database);
    observations = new ContentPlanObservationRepository(database.kysely);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await admin
      ?.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      .catch(() => undefined);
    await admin?.close().catch(() => undefined);
  });

  it("commits or rolls back assistant message, audit, observation, and reused vector together", async () => {
    const fixture = await createFixture("atomic");
    const providerCall = vi.fn();
    const registrationResults: ContentPlanTurnRegistrationResult[] = [];
    const writer: CommittedAssistantTurnObservationWriter = {
      async write(input: CommittedAssistantTurnObservation, transaction: Db): Promise<void> {
        registrationResults.push(
          await observations.registerTurn(registrationFor(input, fixture), transaction),
        );
      },
    };
    const persistence = new PostgresAssistantTurnPersistence(
      database.kysely,
      60_000,
      undefined,
      writer,
    );
    const committedTurnObservation = committedObservationFor(fixture);

    await expect(
      persistence.completeAssistantTurn({
        workspaceId: fixture.workspaceId,
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        assistantMessage: {
          id: fixture.assistantMessageId,
          conversationId: fixture.conversationId,
          workspaceId: fixture.workspaceId,
          role: "assistant",
          content: "Use the deployment settings.",
          grounding: committedTurnObservation.grounding ?? undefined,
        },
        auditEvent: {
          eventType: "chat.answer",
          eventStatus: "success",
          workspaceId: fixture.workspaceId,
          metadata: { assistantMessageId: fixture.assistantMessageId },
        },
        additionalAuditEvent: {
          eventType: "content.plan.test_failure",
          eventStatus: "success",
          workspaceId: randomUUID(),
          metadata: {},
        },
        committedTurnObservation,
      }),
    ).rejects.toMatchObject({ code: "23503" });

    const rolledBack = await database.queryOne<{
      assistant_messages: string;
      audits: string;
      observations: string;
      vectors: string;
    }>(
      `SELECT
         (SELECT count(*) FROM messages WHERE id = $1)::text AS assistant_messages,
         (SELECT count(*) FROM audit_events WHERE workspace_id = $2 AND event_type = 'chat.answer')::text AS audits,
         (SELECT count(*) FROM content_plan_observations WHERE workspace_id = $2)::text AS observations,
         (SELECT count(*) FROM content_plan_observation_vectors WHERE workspace_id = $2)::text AS vectors`,
      [fixture.assistantMessageId, fixture.workspaceId],
    );
    expect(rolledBack).toEqual({
      assistant_messages: "0",
      audits: "0",
      observations: "0",
      vectors: "0",
    });

    await persistence.completeAssistantTurn({
      workspaceId: fixture.workspaceId,
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      assistantMessage: {
        id: fixture.assistantMessageId,
        conversationId: fixture.conversationId,
        workspaceId: fixture.workspaceId,
        role: "assistant",
        content: "Use the deployment settings.",
        grounding: committedTurnObservation.grounding ?? undefined,
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: fixture.workspaceId,
        metadata: { assistantMessageId: fixture.assistantMessageId },
      },
      committedTurnObservation,
    });

    expect(providerCall).not.toHaveBeenCalled();
    expect(registrationResults.at(-1)).toMatchObject({
      acceptedCount: 1,
      duplicateCount: 0,
      truncatedCount: 0,
    });
    const committed = await database.queryOne<{
      assistant_messages: string;
      audits: string;
      observations: string;
      vectors: string;
      vector_source: string;
      vector_state: string;
    }>(
      `SELECT
         (SELECT count(*) FROM messages WHERE id = $1)::text AS assistant_messages,
         (SELECT count(*) FROM audit_events WHERE workspace_id = $2 AND event_type = 'chat.answer')::text AS audits,
         (SELECT count(*) FROM content_plan_observations WHERE workspace_id = $2)::text AS observations,
         (SELECT count(*) FROM content_plan_observation_vectors WHERE workspace_id = $2)::text AS vectors,
         (SELECT vector_source FROM content_plan_observation_vectors WHERE workspace_id = $2 LIMIT 1) AS vector_source,
         (SELECT state FROM content_plan_observation_vectors WHERE workspace_id = $2 LIMIT 1) AS vector_state`,
      [fixture.assistantMessageId, fixture.workspaceId],
    );
    expect(committed).toEqual({
      assistant_messages: "1",
      audits: "1",
      observations: "1",
      vectors: "1",
      vector_source: "reused",
      vector_state: "ready",
    });
  });

  it("stores clarification semantics only on the earlier source and an opaque pointer on the value", async () => {
    const fixture = await createFixture("clarification-metadata");
    const sourceUserMessageId = randomUUID();
    const semanticText = "Does the product support Okta?";
    await database.execute(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, metadata_json)
       VALUES ($1, $2, $3, 'user', 'Does the product support it?', $4::jsonb)`,
      [
        sourceUserMessageId,
        fixture.conversationId,
        fixture.workspaceId,
        JSON.stringify({
          conversationInteraction: {
            version: 1,
            role: "unresolved",
            semanticIntents: [],
          },
        }),
      ],
    );
    const committedTurnObservation: CommittedAssistantTurnObservation = {
      ...committedObservationFor(fixture, [{ id: "primary", text: semanticText }]),
      currentUserMessageId: fixture.userMessageId,
      sourceUserMessageId,
      interaction: {
        role: "clarification_value",
        semanticIntents: [{ id: "primary", text: semanticText }],
      },
    };
    const writer = { write: vi.fn(async () => undefined) };
    const persistence = new PostgresAssistantTurnPersistence(
      database.kysely,
      60_000,
      undefined,
      writer,
    );

    await persistence.completeAssistantTurn({
      workspaceId: fixture.workspaceId,
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      assistantMessage: {
        id: fixture.assistantMessageId,
        conversationId: fixture.conversationId,
        workspaceId: fixture.workspaceId,
        role: "assistant",
        content: "Okta is supported.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: fixture.workspaceId,
        metadata: { assistantMessageId: fixture.assistantMessageId },
      },
      committedTurnObservation,
    });

    const stored = await database.query<{
      id: string;
      metadata_json: Record<string, unknown>;
    }>(
      `SELECT id, metadata_json
       FROM messages
       WHERE workspace_id = $1 AND id = ANY($2::uuid[])
       ORDER BY id`,
      [fixture.workspaceId, [sourceUserMessageId, fixture.userMessageId]],
    );
    const byId = new Map(stored.map((message) => [message.id, message.metadata_json]));
    expect(byId.get(fixture.userMessageId)).toEqual({
      conversationInteraction: {
        version: 1,
        role: "clarification_value",
        sourceUserMessageId,
      },
    });
    expect(byId.get(sourceUserMessageId)).toEqual({
      conversationInteraction: {
        version: 1,
        role: "unresolved",
        semanticIntents: [],
      },
      conversationInteractionResolution: {
        version: 1,
        role: "clarification_value",
        valueUserMessageId: fixture.userMessageId,
        semanticIntents: [{ id: "primary", text: semanticText }],
      },
    });

    await database.execute("DELETE FROM messages WHERE workspace_id = $1 AND id = $2", [
      fixture.workspaceId,
      sourceUserMessageId,
    ]);
    const remaining = await database.queryOne<{ metadata_json: Record<string, unknown> }>(
      "SELECT metadata_json FROM messages WHERE workspace_id = $1 AND id = $2",
      [fixture.workspaceId, fixture.userMessageId],
    );
    expect(JSON.stringify(remaining.metadata_json)).not.toContain(semanticText);
    expect(remaining.metadata_json).toEqual({
      conversationInteraction: {
        version: 1,
        role: "clarification_value",
        sourceUserMessageId,
      },
    });
  });

  it("atomically initializes a null-progress target and retains the turn-time vector before projection exists", async () => {
    const fixture = await createFixture("provisional-target");
    await database.execute(
      `INSERT INTO workspace_embedding_profiles (workspace_id, active_embedding_space_id)
       VALUES ($1, $2)`,
      [fixture.workspaceId, fixture.embeddingSpaceId],
    );
    const committedTurnObservation = committedObservationFor(fixture);
    const persistence = new PostgresAssistantTurnPersistence(
      database.kysely,
      60_000,
      undefined,
      new ContentPlanningCommittedTurnWriter(),
    );

    await persistence.completeAssistantTurn({
      workspaceId: fixture.workspaceId,
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      assistantMessage: {
        id: fixture.assistantMessageId,
        conversationId: fixture.conversationId,
        workspaceId: fixture.workspaceId,
        role: "assistant",
        content: "Use the deployment settings.",
      },
      auditEvent: {
        eventType: "chat.answer",
        eventStatus: "success",
        workspaceId: fixture.workspaceId,
        metadata: { assistantMessageId: fixture.assistantMessageId },
      },
      committedTurnObservation,
    });

    const state = await database.queryOne<{
      target_generation_id: string;
      bootstrap_processed: string | null;
      bootstrap_total: string | null;
    }>(
      `SELECT target_generation_id, bootstrap_processed, bootstrap_total
       FROM content_plan_projection_states
       WHERE workspace_id = $1`,
      [fixture.workspaceId],
    );
    expect(state).toMatchObject({
      bootstrap_processed: null,
      bootstrap_total: null,
    });
    const durable = await database.queryOne<{
      generation_state: string;
      observation_count: string;
      vector_state: string;
      vector_source: string;
      embedding_space_id: string;
    }>(
      `SELECT
         generation.state AS generation_state,
         (SELECT COUNT(*)::text FROM content_plan_observations observation
           WHERE observation.workspace_id = $1) AS observation_count,
         vector.state AS vector_state,
         vector.vector_source,
         vector.embedding_space_id
       FROM content_plan_projection_generations generation
       JOIN content_plan_observation_vectors vector
         ON vector.workspace_id = generation.workspace_id
        AND vector.generation_id = generation.id
       WHERE generation.workspace_id = $1 AND generation.id = $2`,
      [fixture.workspaceId, state.target_generation_id],
    );
    expect(durable).toEqual({
      generation_state: "building",
      observation_count: "1",
      vector_state: "ready",
      vector_source: "reused",
      embedding_space_id: fixture.embeddingSpaceId,
    });
  });

  it("is idempotent and bounds one turn to four distinct semantic contributions without provider work", async () => {
    const fixture = await createFixture("bounded");
    await database.execute(
      `INSERT INTO messages (
         id, conversation_id, workspace_id, role, content,
         grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
         grounding_unsourced_claim_count, grounding_invalid_source_count
       ) VALUES ($1, $2, $3, 'assistant', 'Answer', 'grounded', 1, 1, 0, 0)`,
      [fixture.assistantMessageId, fixture.conversationId, fixture.workspaceId],
    );
    const providerCall = vi.fn();
    const semanticIntents = Array.from(
      { length: MAX_CONTENT_PLAN_TURN_CONTRIBUTIONS + 2 },
      (_, index) => ({ id: `subquery_${index + 1}`, text: `semantic intent ${index + 1}` }),
    );
    const input = registrationFor(committedObservationFor(fixture, semanticIntents), fixture);

    const first = await observations.registerTurn(input);
    const duplicate = await observations.registerTurn(input);

    expect(first).toMatchObject({
      acceptedCount: MAX_CONTENT_PLAN_TURN_CONTRIBUTIONS,
      duplicateCount: 0,
      truncatedCount: 2,
    });
    expect(duplicate).toMatchObject({
      acceptedCount: 0,
      duplicateCount: MAX_CONTENT_PLAN_TURN_CONTRIBUTIONS,
      truncatedCount: 2,
    });
    expect(first.observations.map((observation) => observation.semanticIntentId)).toEqual([
      "subquery_1",
      "subquery_2",
      "subquery_3",
      "subquery_4",
    ]);
    expect(providerCall).not.toHaveBeenCalled();

    const counts = await database.queryOne<{ observations: string; vectors: string }>(
      `SELECT
         (SELECT count(*) FROM content_plan_observations WHERE workspace_id = $1)::text AS observations,
         (SELECT count(*) FROM content_plan_observation_vectors WHERE workspace_id = $1)::text AS vectors`,
      [fixture.workspaceId],
    );
    expect(counts).toEqual({ observations: "4", vectors: "4" });
  });
});
