import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import {
  PostgresAudiencePulseHistorySource,
  audiencePulseCandidateQueryLimit,
  buildAudiencePulseAggregateQuery,
  buildAudiencePulseBoundedCandidateQuery,
  buildAudiencePulseEvidenceAnchorNextAssistantQuery,
  buildAudiencePulseEvidenceAnchorTargetQuery,
  buildAudiencePulseQuestionAnswerQuery,
} from "../../../src/modules/chat/audiencePulseHistorySource.js";
import { DEFAULT_AUDIENCE_PULSE_SAMPLE_POLICY } from "../../../src/modules/audiencePulse/contracts.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

interface MessageFixture {
  id?: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  source: string | null;
  skillName?: string | null;
  skillOutcome?: string | null;
  grounding?: "grounded" | "degraded" | "no_support" | null;
}

describeIntegration("PostgresAudiencePulseHistorySource", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const source = new PostgresAudiencePulseHistorySource(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  const createConversation = async (sourceChannel: string | null = null): Promise<string> => {
    const id = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, $3)",
      [id, workspaceId, sourceChannel],
    );
    return id;
  };

  const createMessage = async (fixture: MessageFixture): Promise<string> => {
    const id = fixture.id ?? randomUUID();
    const completeGrounding = fixture.grounding !== null && fixture.grounding !== undefined;
    await database.query(
      `INSERT INTO messages (
        id, conversation_id, role, content, created_at, workspace_id, source,
        skill_name, skill_outcome, grounding_verdict,
        grounding_claim_count, grounding_sourced_claim_count,
        grounding_unsourced_claim_count, grounding_invalid_source_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        fixture.conversationId,
        fixture.role,
        fixture.content,
        fixture.createdAt,
        workspaceId,
        fixture.source,
        fixture.skillName ?? null,
        fixture.skillOutcome ?? null,
        fixture.grounding ?? null,
        completeGrounding ? 1 : null,
        completeGrounding ? 0 : null,
        completeGrounding ? 1 : null,
        completeGrounding ? 0 : null,
      ],
    );
    return id;
  };

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Audience Pulse History Test", `audience-pulse-history-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Audience Pulse History Workspace", `audience-pulse-history-${workspaceId}`],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM messages WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM conversations WHERE workspace_id = $1", [workspaceId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("uses bounded metadata candidates and one-message answer windows", () => {
    const analysisInput = {
      workspaceId,
      analysisStart: new Date("2026-07-01T00:00:00.000Z"),
      analysisEnd: new Date("2026-07-31T00:00:00.000Z"),
    };
    const policy = {
      ...DEFAULT_AUDIENCE_PULSE_SAMPLE_POLICY,
      maxQuestions: 3,
      maxConversations: 3,
      maxQuestionsPerConversation: 1,
    };
    const aggregateSql = buildAudiencePulseAggregateQuery(database.kysely, analysisInput).compile().sql;
    const candidateSql = buildAudiencePulseBoundedCandidateQuery(database.kysely, {
      ...analysisInput,
      samplePolicy: policy,
    }).compile().sql;
    const answerSql = buildAudiencePulseQuestionAnswerQuery(database.kysely, {
      workspaceId,
      analysisEnd: analysisInput.analysisEnd,
      question: {
        id: "00000000-0000-0000-0000-000000000001",
        conversation_id: "10000000-0000-0000-0000-000000000001",
        created_at: analysisInput.analysisStart,
      },
    }).compile().sql;

    expect(aggregateSql).toContain("count(");
    expect(aggregateSql).not.toContain("content");
    expect(candidateSql).toContain("row_number()");
    expect(candidateSql).not.toContain("content");
    expect(candidateSql).toMatch(/limit \$\d+/i);
    expect(answerSql).not.toContain("content");
    expect(answerSql).toContain('"m"."role" in');
    expect(answerSql).toMatch(/limit \$\d+/i);
    expect(audiencePulseCandidateQueryLimit(policy)).toBe(9);
  });

  it("counts the UTC end-user population and pairs only the first eligible AI answer before the next user turn", async () => {
    const legacyConversation = await createConversation();
    const emailConversation = await createConversation("email");
    const humanConversation = await createConversation();
    const incompleteConversation = await createConversation();
    const endCutoffConversation = await createConversation();
    const operatorConversation = await createConversation("authenticated_chat");

    const legacyQuestionId = "00000000-0000-0000-0000-000000000001";
    await createMessage({
      id: legacyQuestionId,
      conversationId: legacyConversation,
      role: "user",
      content: "Legacy customer question",
      createdAt: "2026-07-01T00:00:00.000Z",
      source: null,
    });
    await createMessage({
      id: "00000000-0000-0000-0000-000000000002",
      conversationId: legacyConversation,
      role: "assistant",
      content: "Answer not included in evidence",
      createdAt: "2026-07-01T00:00:00.000Z",
      source: "ai_agent",
      skillName: "retrieval.answer",
      skillOutcome: "no_context",
      grounding: "no_support",
    });

    const degradedQuestionId = await createMessage({
      conversationId: emailConversation,
      role: "user",
      content: "Partially grounded question",
      createdAt: "2026-07-02T10:00:00.000Z",
      source: "customer",
    });
    await createMessage({
      conversationId: emailConversation,
      role: "assistant",
      content: "Answer not included in evidence",
      createdAt: "2026-07-02T10:00:01.000Z",
      source: "ai_agent",
      skillName: "retrieval.answer",
      skillOutcome: "grounded_degraded",
      grounding: "degraded",
    });

    const cutoffQuestionId = await createMessage({
      conversationId: emailConversation,
      role: "user",
      content: "Question superseded by a follow-up",
      createdAt: "2026-07-03T10:00:00.000Z",
      source: "customer",
    });
    const nextQuestionId = await createMessage({
      conversationId: emailConversation,
      role: "user",
      content: "Follow-up question",
      createdAt: "2026-07-03T10:00:01.000Z",
      source: "customer",
    });
    await createMessage({
      conversationId: emailConversation,
      role: "assistant",
      content: "Answer not included in evidence",
      createdAt: "2026-07-03T10:00:02.000Z",
      source: "ai_agent",
      skillName: "retrieval.answer",
      skillOutcome: "out_of_scope",
      grounding: "no_support",
    });

    const humanQuestionId = await createMessage({
      conversationId: humanConversation,
      role: "user",
      content: "Question with a human reply",
      createdAt: "2026-07-08T10:00:00.000Z",
      source: "customer",
    });
    await createMessage({
      conversationId: humanConversation,
      role: "assistant",
      content: "Human answer",
      createdAt: "2026-07-08T10:00:01.000Z",
      source: "human_agent",
    });
    await createMessage({
      conversationId: humanConversation,
      role: "assistant",
      content: "Later AI answer must not replace the human reply",
      createdAt: "2026-07-08T10:00:02.000Z",
      source: "ai_agent",
      skillName: "retrieval.answer",
      skillOutcome: "no_context",
      grounding: "no_support",
    });

    const incompleteQuestionId = await createMessage({
      conversationId: incompleteConversation,
      role: "user",
      content: "Question with no persisted diagnostic",
      createdAt: "2026-07-15T10:00:00.000Z",
      source: "customer",
    });
    await createMessage({
      conversationId: incompleteConversation,
      role: "assistant",
      content: "Unclassified answer",
      createdAt: "2026-07-15T10:00:01.000Z",
      source: "ai_agent",
    });

    const endCutoffQuestionId = await createMessage({
      conversationId: endCutoffConversation,
      role: "user",
      content: "Question whose answer starts at the end bound",
      createdAt: "2026-07-30T23:59:00.000Z",
      source: "customer",
    });
    await createMessage({
      conversationId: endCutoffConversation,
      role: "assistant",
      content: "Must be excluded by analysisEnd",
      createdAt: "2026-07-31T00:00:00.000Z",
      source: "ai_agent",
      skillName: "retrieval.answer",
      skillOutcome: "no_context",
      grounding: "no_support",
    });

    await createMessage({
      conversationId: operatorConversation,
      role: "user",
      content: "Operator dashboard test traffic",
      createdAt: "2026-07-10T10:00:00.000Z",
      source: "customer",
    });
    await createMessage({
      conversationId: emailConversation,
      role: "user",
      content: "Non-customer source must be excluded",
      createdAt: "2026-07-10T10:00:00.000Z",
      source: "ai_agent",
    });
    await createMessage({
      conversationId: emailConversation,
      role: "user",
      content: "Before the half-open period",
      createdAt: "2026-06-30T23:59:59.000Z",
      source: "customer",
    });
    await createMessage({
      conversationId: emailConversation,
      role: "user",
      content: "At the excluded period end",
      createdAt: "2026-07-31T00:00:00.000Z",
      source: "customer",
    });

    const snapshot = await source.read({
      workspaceId,
      analysisStart: new Date("2026-07-01T00:00:00.000Z"),
      analysisEnd: new Date("2026-07-31T00:00:00.000Z"),
      samplePolicy: DEFAULT_AUDIENCE_PULSE_SAMPLE_POLICY,
    });
    const evidenceByMessageId = new Map(snapshot.evidence.map((item) => [item.reference.messageId, item]));

    expect(snapshot.coverage).toEqual({ populationSize: 7, sampleSize: 7, sampled: false });
    expect(snapshot.weeklyVolume).toEqual([
      { weekStart: "2026-06-29T00:00:00.000Z", visitorQuestionCount: 4, conversationCount: 2 },
      { weekStart: "2026-07-06T00:00:00.000Z", visitorQuestionCount: 1, conversationCount: 1 },
      { weekStart: "2026-07-13T00:00:00.000Z", visitorQuestionCount: 1, conversationCount: 1 },
      { weekStart: "2026-07-27T00:00:00.000Z", visitorQuestionCount: 1, conversationCount: 1 },
    ]);
    expect(evidenceByMessageId.get(legacyQuestionId)).toMatchObject({
      grounding: "no_support",
      contentGapEligible: true,
    });
    expect(evidenceByMessageId.get(degradedQuestionId)).toMatchObject({
      grounding: "degraded",
      contentGapEligible: true,
      channel: "email",
    });
    expect(evidenceByMessageId.get(cutoffQuestionId)).toMatchObject({
      grounding: "unknown",
      contentGapEligible: false,
    });
    expect(evidenceByMessageId.get(nextQuestionId)).toMatchObject({
      grounding: "no_support",
      contentGapEligible: false,
    });
    expect(evidenceByMessageId.get(humanQuestionId)).toMatchObject({
      grounding: "unknown",
      contentGapEligible: false,
    });
    expect(evidenceByMessageId.get(incompleteQuestionId)).toMatchObject({
      grounding: "unknown",
      contentGapEligible: false,
    });
    expect(evidenceByMessageId.get(endCutoffQuestionId)).toMatchObject({
      grounding: "unknown",
      contentGapEligible: false,
    });
  });

  it("keeps exact large-population aggregates while the evidence sample remains bounded", async () => {
    const populationSize = 90;
    const sourceText = "x".repeat(4_000);
    await Promise.all(Array.from({ length: populationSize }, async (_, index) => {
      const conversationId = await createConversation();
      await createMessage({
        conversationId,
        role: "user",
        content: `Large population question ${index}: ${sourceText}`,
        createdAt: new Date(Date.UTC(2026, 6, 20, 0, index, 0)).toISOString(),
        source: "customer",
      });
    }));

    const samplePolicy = {
      ...DEFAULT_AUDIENCE_PULSE_SAMPLE_POLICY,
      maxQuestions: 3,
      maxConversations: 3,
      maxQuestionsPerConversation: 1,
      maxExcerptCharacters: 3_600,
    };
    const candidates = await buildAudiencePulseBoundedCandidateQuery(database.kysely, {
      workspaceId,
      analysisStart: new Date("2026-07-01T00:00:00.000Z"),
      analysisEnd: new Date("2026-07-31T00:00:00.000Z"),
      samplePolicy,
    }).execute();
    expect(candidates).toHaveLength(audiencePulseCandidateQueryLimit(samplePolicy));

    const snapshot = await source.read({
      workspaceId,
      analysisStart: new Date("2026-07-01T00:00:00.000Z"),
      analysisEnd: new Date("2026-07-31T00:00:00.000Z"),
      samplePolicy,
    });

    expect(snapshot.coverage).toEqual({ populationSize, sampleSize: 3, sampled: true });
    expect(snapshot.weeklyVolume).toEqual([
      { weekStart: "2026-07-20T00:00:00.000Z", visitorQuestionCount: populationSize, conversationCount: populationSize },
    ]);
    expect(snapshot.evidence).toHaveLength(3);
    expect(snapshot.evidence.every((item) => item.question.length <= 1_200)).toBe(true);
  });

  it("pairs a selected question through a bounded answer window in a long-lived conversation", async () => {
    const conversationId = await createConversation();
    const questionId = await createMessage({
      conversationId,
      role: "user",
      content: "Does this plan include exports?",
      createdAt: "2026-07-15T10:00:00.000Z",
      source: "customer",
    });
    await Promise.all(Array.from({ length: 240 }, (_, index) => createMessage({
      conversationId,
      role: "system",
      content: `Long-lived system event ${index}`,
      createdAt: new Date(Date.UTC(2026, 6, 15, 10, 0, index + 1)).toISOString(),
      source: null,
    })));
    await createMessage({
      conversationId,
      role: "assistant",
      content: "Answer after many non-boundary records",
      createdAt: "2026-07-15T10:05:00.000Z",
      source: "ai_agent",
      skillName: "retrieval.answer",
      skillOutcome: "no_context",
      grounding: "no_support",
    });

    const snapshot = await source.read({
      workspaceId,
      analysisStart: new Date("2026-07-01T00:00:00.000Z"),
      analysisEnd: new Date("2026-07-31T00:00:00.000Z"),
      samplePolicy: {
        ...DEFAULT_AUDIENCE_PULSE_SAMPLE_POLICY,
        maxQuestions: 1,
        maxConversations: 1,
        maxQuestionsPerConversation: 1,
      },
    });

    expect(snapshot.coverage).toEqual({ populationSize: 1, sampleSize: 1, sampled: false });
    expect(snapshot.evidence[0]).toMatchObject({
      reference: { messageId: questionId, conversationId },
      grounding: "no_support",
      contentGapEligible: true,
    });
  });

  it("reads an exact bounded anchor from its workspace and conversation after a long history", async () => {
    const conversationId = await createConversation();
    const otherConversationId = await createConversation();
    const targetId = await createMessage({
      conversationId,
      role: "user",
      content: "q".repeat(1_400),
      createdAt: "2026-07-15T10:00:00.000Z",
      source: "customer",
    });
    await Promise.all(Array.from({ length: 240 }, (_, index) => createMessage({
      conversationId,
      role: "system",
      content: `Long-lived system event ${index}`,
      createdAt: new Date(Date.UTC(2026, 6, 15, 10, 0, index + 1)).toISOString(),
      source: null,
    })));
    const assistantId = await createMessage({
      conversationId,
      role: "assistant",
      content: "a".repeat(1_400),
      createdAt: "2026-07-15T10:05:00.000Z",
      source: "human_agent",
    });

    const targetSql = buildAudiencePulseEvidenceAnchorTargetQuery(database.kysely, {
      workspaceId,
      conversationId,
      messageId: targetId,
    }).compile().sql;
    const nextAssistantSql = buildAudiencePulseEvidenceAnchorNextAssistantQuery(database.kysely, {
      workspaceId,
      conversationId,
      source: { id: targetId, created_at: new Date("2026-07-15T10:00:00.000Z") },
    }).compile().sql;
    expect(targetSql).toContain("left(m.content");
    expect(targetSql).toMatch(/limit \$\d+/i);
    expect(nextAssistantSql).toContain('"m"."role" in');
    expect(nextAssistantSql).toContain("left(m.content");
    expect(nextAssistantSql).toMatch(/limit \$\d+/i);

    const anchor = await source.readEvidenceAnchor({
      workspaceId,
      conversationId,
      messageId: targetId,
    });

    expect(anchor).toEqual({
      conversationId,
      source: {
        messageId: targetId,
        role: "user",
        source: "customer",
        content: "q".repeat(1_200),
        createdAt: "2026-07-15T10:00:00.000Z",
      },
      nextAssistant: {
        messageId: assistantId,
        role: "assistant",
        source: "human_agent",
        content: "a".repeat(1_200),
        createdAt: "2026-07-15T10:05:00.000Z",
      },
    });
    await expect(source.readEvidenceAnchor({
      workspaceId,
      conversationId: otherConversationId,
      messageId: targetId,
    })).resolves.toBeNull();
    await expect(source.readEvidenceAnchor({
      workspaceId: randomUUID(),
      conversationId,
      messageId: targetId,
    })).resolves.toBeNull();
  });

  it("stops an anchor context at the next visitor turn", async () => {
    const conversationId = await createConversation();
    const targetId = await createMessage({
      conversationId,
      role: "user",
      content: "First visitor question",
      createdAt: "2026-07-15T10:00:00.000Z",
      source: "customer",
    });
    await createMessage({
      conversationId,
      role: "user",
      content: "Follow-up visitor question",
      createdAt: "2026-07-15T10:00:01.000Z",
      source: "customer",
    });
    await createMessage({
      conversationId,
      role: "assistant",
      content: "This reply belongs to the follow-up",
      createdAt: "2026-07-15T10:00:02.000Z",
      source: "ai_agent",
    });

    const anchor = await source.readEvidenceAnchor({ workspaceId, conversationId, messageId: targetId });

    expect(anchor?.nextAssistant).toBeNull();
  });
});
