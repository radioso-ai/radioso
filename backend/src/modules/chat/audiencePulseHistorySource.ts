import type { MessageSource } from "@radioso/conversation-contract";
import { sql } from "kysely";

import {
  AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS,
  type AudiencePulseEvidence,
  type AudiencePulseEvidenceAnchor,
  AudiencePulseHistorySnapshot,
  AudiencePulseHistorySource,
  AudiencePulseHydratedEvidence,
  AudiencePulsePromptEvidenceReference,
  type AudiencePulseWeeklyVolume,
} from "../audiencePulse/contracts/history.js";
import { OPERATOR_TEST_SOURCE_CHANNELS } from "../../shared/domain/conversationSource.js";
import { isHumanAuthoredMessageSource } from "../../shared/domain/messageAuthorship.js";
import { deriveMessageSourceFromRole } from "../../db/repositories/messageRepository.js";
import {
  audiencePulseContentGapEligible,
  type AudiencePulseGroundingSignal,
} from "../../shared/domain/audiencePulseContentGap.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface AudiencePulseEligibleQuestionMetadataRow {
  id: string;
  conversation_id: string;
  created_at: Date;
  source_channel: string | null;
}

export interface AudiencePulseEligibleQuestionRow extends AudiencePulseEligibleQuestionMetadataRow {
  content: string;
}

export interface AudiencePulseConversationMessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  source: MessageSource | null;
  skill_name: string | null;
  skill_outcome: string | null;
  grounding_verdict: "grounded" | "degraded" | "no_support" | null;
  grounding_claim_count: number | null;
  grounding_sourced_claim_count: number | null;
  grounding_unsourced_claim_count: number | null;
  grounding_invalid_source_count: number | null;
  created_at: Date;
}

interface RehydratedQuestionRow {
  id: string;
  conversation_id: string;
  content: string;
  role: "user" | "assistant" | "system";
  source: MessageSource | null;
  source_channel: string | null;
}

interface AudiencePulseAnchorMessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  source: MessageSource | null;
  content: string;
  created_at: Date;
}

export const audiencePulseWeekStartUtc = (date: Date): string => {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = result.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  result.setUTCDate(result.getUTCDate() - daysSinceMonday);
  return result.toISOString();
};

/** Completes calendar buckets after SQL computes exact non-zero aggregates. */
export const completeAudiencePulseWeeklyVolume = (input: {
  analysisStart: Date;
  analysisEnd: Date;
  aggregate: AudiencePulseWeeklyVolume[];
}): AudiencePulseWeeklyVolume[] => {
  const aggregateByWeek = new Map(input.aggregate.map((week) => [
    new Date(week.weekStart).toISOString(),
    week,
  ]));
  const complete: AudiencePulseWeeklyVolume[] = [];
  const cursor = new Date(audiencePulseWeekStartUtc(input.analysisStart));
  while (cursor < input.analysisEnd) {
    const weekStart = cursor.toISOString();
    const aggregate = aggregateByWeek.get(weekStart);
    complete.push(aggregate ?? {
      weekStart,
      visitorQuestionCount: 0,
      conversationCount: 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return complete;
};

export const isAudiencePulseEndUserChannel = (sourceChannel: string | null): boolean =>
  sourceChannel === null || !(OPERATOR_TEST_SOURCE_CHANNELS as readonly string[]).includes(sourceChannel);

export const isAudiencePulseCustomerSource = (source: MessageSource | null): boolean =>
  source === null || source === "customer";

const hasCompleteGrounding = (row: AudiencePulseConversationMessageRow): boolean =>
  row.grounding_verdict !== null
    && row.grounding_claim_count !== null
    && row.grounding_sourced_claim_count !== null
    && row.grounding_unsourced_claim_count !== null
    && row.grounding_invalid_source_count !== null;

export const classifyAudiencePulseAnswerWindow = (messages: AudiencePulseConversationMessageRow[]): {
  grounding: AudiencePulseGroundingSignal;
  contentGapEligible: boolean;
} => {
  for (const message of messages) {
    if (message.role === "user") break;
    if (message.role !== "assistant") continue;
    if (isHumanAuthoredMessageSource(message.source)) {
      return { grounding: "unknown", contentGapEligible: false };
    }
    if (!hasCompleteGrounding(message)) {
      return { grounding: "unknown", contentGapEligible: false };
    }
    const grounding = message.grounding_verdict!;
    return {
      grounding,
      contentGapEligible: audiencePulseContentGapEligible({
        assistantAuthorship: "ai",
        skillName: message.skill_name,
        skillOutcome: message.skill_outcome,
        grounding,
      }),
    };
  }
  return { grounding: "unknown", contentGapEligible: false };
};

export const classifyAudiencePulseQuestion = (
  question: AudiencePulseEligibleQuestionMetadataRow,
  messages: AudiencePulseConversationMessageRow[],
): {
  grounding: AudiencePulseGroundingSignal;
  contentGapEligible: boolean;
} => {
  const questionIndex = messages.findIndex((message) => message.id === question.id);
  if (questionIndex < 0) return { grounding: "unknown", contentGapEligible: false };
  return classifyAudiencePulseAnswerWindow(messages.slice(questionIndex + 1));
};

const audiencePulseWeekStartExpression = sql<Date>`date_trunc('week', m.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

/** Shared authorization/period predicate. Callers must choose a bounded projection. */
const buildAudiencePulseEligibleQuestionQuery = (
  db: Db,
  input: { workspaceId: string; analysisStart: Date; analysisEnd: Date },
) => db
  .selectFrom("messages as m")
  .innerJoin("conversations as c", (join) =>
    join.onRef("c.id", "=", "m.conversation_id").onRef("c.workspace_id", "=", "m.workspace_id"),
  )
  .where("m.workspace_id", "=", input.workspaceId)
  .where("m.role", "=", "user")
  .where("m.created_at", ">=", input.analysisStart)
  .where("m.created_at", "<", input.analysisEnd)
  .where((eb) => eb.or([eb("m.source", "is", null), eb("m.source", "=", "customer")]))
  .where((eb) => eb.or([
    eb("c.source_channel", "is", null),
    eb("c.source_channel", "not in", [...OPERATOR_TEST_SOURCE_CHANNELS]),
  ]));

interface AudiencePulseAggregateRow {
  week_start: Date;
  visitor_question_count: string;
  conversation_count: string;
  population_size: string;
}

/** Exact aggregate rows (at most the UTC weeks in the fixed analysis period). */
export const buildAudiencePulseAggregateQuery = (
  db: Db,
  input: { workspaceId: string; analysisStart: Date; analysisEnd: Date },
) => buildAudiencePulseEligibleQuestionQuery(db, input)
  .select([
    audiencePulseWeekStartExpression.as("week_start"),
    sql<string>`count(*)::text`.as("visitor_question_count"),
    sql<string>`count(distinct m.conversation_id)::text`.as("conversation_count"),
    sql<string>`sum(count(*)) over ()::text`.as("population_size"),
  ])
  .groupBy(audiencePulseWeekStartExpression)
  .orderBy(audiencePulseWeekStartExpression, "asc");

/**
 * Every eligible question's content and metadata in one pass (spec 956 FR-003): no
 * candidate reserve, no stratified rank, no cap. The census clusters this exact set,
 * so `read()` fetches it directly instead of narrowing to a sample first.
 */
export const buildAudiencePulseEligibleQuestionContentQuery = (
  db: Db,
  input: { workspaceId: string; analysisStart: Date; analysisEnd: Date },
) => buildAudiencePulseEligibleQuestionQuery(db, input)
  .select([
    "m.id as id",
    "m.conversation_id as conversation_id",
    "m.created_at as created_at",
    "c.source_channel as source_channel",
  ])
  // Keep transport and memory bounded even when a visitor message is very large.
  .select(sql<string>`left(m.content, ${AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS})`.as("content"))
  .orderBy("m.created_at", "asc")
  .orderBy("m.id", "asc");

/** One selected question gets at most its first relevant response boundary. */
export const buildAudiencePulseQuestionAnswerQuery = (
  db: Db,
  input: {
    workspaceId: string;
    analysisEnd: Date;
    question: Pick<AudiencePulseEligibleQuestionMetadataRow, "id" | "conversation_id" | "created_at">;
  },
) => db
  .selectFrom("messages as m")
  .select([
    "m.id as id",
    "m.conversation_id as conversation_id",
    "m.role as role",
    "m.source as source",
    "m.skill_name as skill_name",
    "m.skill_outcome as skill_outcome",
    "m.grounding_verdict as grounding_verdict",
    "m.grounding_claim_count as grounding_claim_count",
    "m.grounding_sourced_claim_count as grounding_sourced_claim_count",
    "m.grounding_unsourced_claim_count as grounding_unsourced_claim_count",
    "m.grounding_invalid_source_count as grounding_invalid_source_count",
    "m.created_at as created_at",
  ])
  .where("m.workspace_id", "=", input.workspaceId)
  .where("m.conversation_id", "=", input.question.conversation_id)
  .where("m.role", "in", ["user", "assistant"])
  .where("m.created_at", "<", input.analysisEnd)
  .where((eb) => eb.or([
    eb("m.created_at", ">", input.question.created_at),
    eb.and([
      eb("m.created_at", "=", input.question.created_at),
      eb("m.id", ">", input.question.id),
    ]),
  ]))
  .orderBy("m.created_at", "asc")
  .orderBy("m.id", "asc")
  .limit(1);

/** Exact source lookup: workspace, conversation, and message must all match. */
export const buildAudiencePulseEvidenceAnchorTargetQuery = (
  db: Db,
  input: { workspaceId: string; conversationId: string; messageId: string },
) => db
  .selectFrom("messages as m")
  .innerJoin("conversations as c", (join) =>
    join.onRef("c.id", "=", "m.conversation_id").onRef("c.workspace_id", "=", "m.workspace_id"),
  )
  .select([
    "m.id as id",
    "m.conversation_id as conversation_id",
    "m.role as role",
    "m.source as source",
    "m.created_at as created_at",
  ])
  .select(sql<string>`left(m.content, ${AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS})`.as("content"))
  .where("m.workspace_id", "=", input.workspaceId)
  .where("c.workspace_id", "=", input.workspaceId)
  .where("m.conversation_id", "=", input.conversationId)
  .where("m.id", "=", input.messageId)
  .where("m.role", "=", "user")
  .where((eb) => eb.or([eb("m.source", "is", null), eb("m.source", "=", "customer")]))
  .where((eb) => eb.or([
    eb("c.source_channel", "is", null),
    eb("c.source_channel", "not in", [...OPERATOR_TEST_SOURCE_CHANNELS]),
  ]))
  .limit(1);

/** At most one user/assistant boundary after the source; systems never expand the window. */
export const buildAudiencePulseEvidenceAnchorNextAssistantQuery = (
  db: Db,
  input: {
    workspaceId: string;
    conversationId: string;
    source: Pick<AudiencePulseAnchorMessageRow, "id" | "created_at">;
  },
) => db
  .selectFrom("messages as m")
  .select([
    "m.id as id",
    "m.conversation_id as conversation_id",
    "m.role as role",
    "m.source as source",
    "m.created_at as created_at",
  ])
  .select(sql<string>`left(m.content, ${AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS})`.as("content"))
  .where("m.workspace_id", "=", input.workspaceId)
  .where("m.conversation_id", "=", input.conversationId)
  .where("m.role", "in", ["user", "assistant"])
  .where((eb) => eb.or([
    eb("m.created_at", ">", input.source.created_at),
    eb.and([
      eb("m.created_at", "=", input.source.created_at),
      eb("m.id", ">", input.source.id),
    ]),
  ]))
  .orderBy("m.created_at", "asc")
  .orderBy("m.id", "asc")
  .limit(1);

const AUDIENCE_PULSE_ANSWER_WINDOW_QUERY_CONCURRENCY = 8;

const readAudiencePulseAnswerWindows = async (
  db: Db,
  input: { workspaceId: string; analysisEnd: Date; questions: AudiencePulseEligibleQuestionRow[] },
): Promise<Map<string, AudiencePulseConversationMessageRow[]>> => {
  const windows = new Map<string, AudiencePulseConversationMessageRow[]>();
  for (let index = 0; index < input.questions.length; index += AUDIENCE_PULSE_ANSWER_WINDOW_QUERY_CONCURRENCY) {
    const batch = input.questions.slice(index, index + AUDIENCE_PULSE_ANSWER_WINDOW_QUERY_CONCURRENCY);
    const results = await Promise.all(batch.map(async (question) => ({
      questionId: question.id,
      message: await buildAudiencePulseQuestionAnswerQuery(db, {
        workspaceId: input.workspaceId,
        analysisEnd: input.analysisEnd,
        question,
      }).executeTakeFirst() as AudiencePulseConversationMessageRow | undefined,
    })));
    for (const result of results) {
      windows.set(result.questionId, result.message ? [result.message] : []);
    }
  }
  return windows;
};

const presentAudiencePulseAnchorMessage = (
  row: AudiencePulseAnchorMessageRow,
): NonNullable<AudiencePulseEvidenceAnchor["nextAssistant"]> => ({
  messageId: row.id,
  role: "assistant",
  source: row.source ?? deriveMessageSourceFromRole(row.role),
  content: row.content,
  createdAt: new Date(row.created_at).toISOString(),
});

const presentAudiencePulseAnchorSource = (
  row: AudiencePulseAnchorMessageRow,
): AudiencePulseEvidenceAnchor["source"] => ({
  messageId: row.id,
  role: "user",
  source: "customer",
  content: row.content,
  createdAt: new Date(row.created_at).toISOString(),
});

/**
 * Chat-owned persistence adapter. Audience Pulse consumes only this narrow source so
 * it cannot select message rows or reinterpret pairing/authorship rules itself.
 */
export class PostgresAudiencePulseHistorySource implements AudiencePulseHistorySource {
  constructor(private readonly db: Db) {}

  /** Reuses the eligible-question predicate this file already owns; adds no new rule. */
  async listEligibleQuestionIds(input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
  }): Promise<string[]> {
    const rows = await buildAudiencePulseEligibleQuestionQuery(this.db, input)
      .select(["m.id as id"])
      .orderBy("m.created_at", "asc")
      .orderBy("m.id", "asc")
      .execute();
    return rows.map((row) => row.id);
  }

  async read(input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
  }): Promise<AudiencePulseHistorySnapshot> {
    // Aggregates remain exact in SQL either way; the evidence read below now covers
    // every eligible question in the window rather than a bounded sample of it
    // (spec 956 FR-003).
    const aggregateRows = await buildAudiencePulseAggregateQuery(this.db, input)
      .execute() as AudiencePulseAggregateRow[];
    const populationSize = Number(aggregateRows[0]?.population_size ?? "0");
    const aggregateWeeklyVolume = aggregateRows.map((row) => ({
      weekStart: new Date(row.week_start).toISOString(),
      visitorQuestionCount: Number(row.visitor_question_count),
      conversationCount: Number(row.conversation_count),
    }));
    const weeklyVolume = completeAudiencePulseWeeklyVolume({
      analysisStart: input.analysisStart,
      analysisEnd: input.analysisEnd,
      aggregate: aggregateWeeklyVolume,
    });
    if (populationSize === 0) {
      return {
        period: { start: input.analysisStart, end: input.analysisEnd },
        coverage: { populationSize, sampleSize: 0, sampled: false },
        weeklyVolume,
        evidence: [],
      };
    }

    const rows = await buildAudiencePulseEligibleQuestionContentQuery(this.db, input)
      .execute() as AudiencePulseEligibleQuestionRow[];
    const answerWindows = await readAudiencePulseAnswerWindows(this.db, {
      workspaceId: input.workspaceId,
      analysisEnd: input.analysisEnd,
      questions: rows,
    });

    // The message id doubles as the evidence id: the census's own membership is
    // keyed by message id, so a topic's member ids resolve directly against this
    // population with no separate translation table.
    const evidence: AudiencePulseEvidence[] = rows.map((question) => {
      const answer = classifyAudiencePulseAnswerWindow(answerWindows.get(question.id) ?? []);
      return {
        id: question.id,
        reference: { messageId: question.id, conversationId: question.conversation_id },
        question: question.content,
        weekStart: audiencePulseWeekStartUtc(question.created_at),
        channel: question.source_channel,
        grounding: answer.grounding,
        contentGapEligible: answer.contentGapEligible,
      };
    });

    return {
      period: { start: input.analysisStart, end: input.analysisEnd },
      coverage: {
        populationSize,
        sampleSize: evidence.length,
        sampled: false,
      },
      weeklyVolume,
      evidence,
    };
  }

  async rehydrate(input: {
    workspaceId: string;
    references: AudiencePulsePromptEvidenceReference[];
  }): Promise<Map<string, AudiencePulseHydratedEvidence>> {
    if (input.references.length === 0) return new Map();
    const messageIds = [...new Set(input.references.map((reference) => reference.messageId))];
    const rows = await this.db
      .selectFrom("messages as m")
      .innerJoin("conversations as c", (join) =>
        join.onRef("c.id", "=", "m.conversation_id").onRef("c.workspace_id", "=", "m.workspace_id"),
      )
      .select([
        "m.id as id",
        "m.conversation_id as conversation_id",
        sql<string>`left(m.content, ${AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS})`.as("content"),
        "m.role as role",
        "m.source as source",
        "c.source_channel as source_channel",
      ])
      .where("m.workspace_id", "=", input.workspaceId)
      .where("m.id", "in", messageIds)
      .execute() as RehydratedQuestionRow[];
    const rowBySource = new Map(rows.map((row) => [`${row.id}:${row.conversation_id}`, row]));
    const hydrated = new Map<string, AudiencePulseHydratedEvidence>();
    for (const reference of input.references) {
      const row = rowBySource.get(`${reference.messageId}:${reference.conversationId}`);
      if (!row || row.role !== "user" || !isAudiencePulseCustomerSource(row.source) || !isAudiencePulseEndUserChannel(row.source_channel)) {
        continue;
      }
      hydrated.set(reference.evidenceId, {
        evidenceId: reference.evidenceId,
        conversationId: reference.conversationId,
        messageId: row.id,
        question: row.content.slice(0, AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS),
      });
    }
    return hydrated;
  }

  async readEvidenceAnchor(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
  }): Promise<AudiencePulseEvidenceAnchor | null> {
    const source = await buildAudiencePulseEvidenceAnchorTargetQuery(this.db, input)
      .executeTakeFirst() as AudiencePulseAnchorMessageRow | undefined;
    if (!source) return null;
    const boundary = await buildAudiencePulseEvidenceAnchorNextAssistantQuery(this.db, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      source,
    }).executeTakeFirst() as AudiencePulseAnchorMessageRow | undefined;

    return {
      conversationId: input.conversationId,
      source: presentAudiencePulseAnchorSource(source),
      nextAssistant: boundary?.role === "assistant"
        ? presentAudiencePulseAnchorMessage(boundary)
        : null,
    };
  }
}
