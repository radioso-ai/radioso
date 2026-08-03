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
  AudiencePulseSamplePolicy,
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

export const selectAudiencePulseSample = (
  rows: AudiencePulseEligibleQuestionMetadataRow[],
  policy: AudiencePulseSamplePolicy,
): AudiencePulseEligibleQuestionMetadataRow[] => {
  const queues = new Map<string, AudiencePulseEligibleQuestionMetadataRow[]>();
  for (const row of rows) {
    const key = `${audiencePulseWeekStartUtc(row.created_at)}:${row.source_channel ?? ""}`;
    const queue = queues.get(key) ?? [];
    queue.push(row);
    queues.set(key, queue);
  }
  const keys = [...queues.keys()].sort();
  const queueIndices = new Map(keys.map((key) => [key, 0]));
  const perConversation = new Map<string, number>();
  const conversations = new Set<string>();
  const selected: AudiencePulseEligibleQuestionMetadataRow[] = [];

  let progressed = true;
  while (selected.length < policy.maxQuestions && progressed) {
    progressed = false;
    for (const key of keys) {
      if (selected.length >= policy.maxQuestions) break;
      const queue = queues.get(key)!;
      let index = queueIndices.get(key) ?? 0;
      while (index < queue.length) {
        const candidate = queue[index]!;
        index += 1;
        queueIndices.set(key, index);
        const currentConversationCount = perConversation.get(candidate.conversation_id) ?? 0;
        const addsConversation = !conversations.has(candidate.conversation_id);
        if (currentConversationCount >= policy.maxQuestionsPerConversation) continue;
        if (addsConversation && conversations.size >= policy.maxConversations) continue;
        selected.push(candidate);
        conversations.add(candidate.conversation_id);
        perConversation.set(candidate.conversation_id, currentConversationCount + 1);
        progressed = true;
        break;
      }
    }
  }
  return selected;
};

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
const audiencePulseChannelKeyExpression = sql<string>`coalesce(c.source_channel, '')`;

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
 * A bounded metadata reserve for the sampler. It gives the deterministic selector
 * fallbacks after conversation caps without materializing an unbounded history.
 */
export const audiencePulseCandidateQueryLimit = (policy: AudiencePulseSamplePolicy): number =>
  policy.maxQuestions * policy.maxConversations;

/**
 * Metadata-only candidates are globally conversation-capped, then interleaved by UTC
 * week/channel rank. The result cap is strict regardless of population size.
 */
export const buildAudiencePulseBoundedCandidateQuery = (
  db: Db,
  input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
    samplePolicy: AudiencePulseSamplePolicy;
  },
) => db
  .with("audience_pulse_eligible", () => buildAudiencePulseEligibleQuestionQuery(db, input)
    .select((eb) => [
      "m.id as id",
      "m.conversation_id as conversation_id",
      "m.created_at as created_at",
      "c.source_channel as source_channel",
      audiencePulseWeekStartExpression.as("week_start"),
      audiencePulseChannelKeyExpression.as("source_channel_key"),
      eb.fn.agg<number>("row_number").over((ob) => ob
        .partitionBy("m.conversation_id")
        .orderBy("m.created_at", "asc")
        .orderBy("m.id", "asc"))
        .as("conversation_rank"),
    ]))
  .with("audience_pulse_stratified", (qb) => qb
    .selectFrom("audience_pulse_eligible")
    .select((eb) => [
      "id",
      "conversation_id",
      "created_at",
      "source_channel",
      "week_start",
      "source_channel_key",
      eb.fn.agg<number>("row_number").over((ob) => ob
        .partitionBy(["week_start", "source_channel_key"])
        .orderBy("created_at", "asc")
        .orderBy("id", "asc"))
        .as("stratum_rank"),
    ])
    .where("conversation_rank", "<=", input.samplePolicy.maxQuestionsPerConversation))
  .selectFrom("audience_pulse_stratified")
  .select([
    "id",
    "conversation_id",
    "created_at",
    "source_channel",
  ])
  .orderBy("stratum_rank", "asc")
  .orderBy("week_start", "asc")
  .orderBy("source_channel_key", "asc")
  .orderBy("created_at", "asc")
  .orderBy("id", "asc")
  .limit(audiencePulseCandidateQueryLimit(input.samplePolicy));

/** Fetches visitor text only after deterministic metadata sampling has bounded ids. */
export const buildAudiencePulseSelectedQuestionQuery = (
  db: Db,
  input: { workspaceId: string; analysisStart: Date; analysisEnd: Date; messageIds: string[] },
) => buildAudiencePulseEligibleQuestionQuery(db, input)
  .select([
    "m.id as id",
    "m.conversation_id as conversation_id",
    "m.created_at as created_at",
    "c.source_channel as source_channel",
  ])
  // Keep transport and memory bounded even when a selected visitor message is very large.
  .select(sql<string>`left(m.content, ${AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS})`.as("content"))
  .where("m.id", "in", input.messageIds);

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

export const boundAudiencePulseQuestionExcerpts = (
  rows: AudiencePulseEligibleQuestionRow[],
  maxExcerptCharacters: number,
): AudiencePulseEligibleQuestionRow[] => {
  const selected: AudiencePulseEligibleQuestionRow[] = [];
  let usedCharacters = 0;
  for (const row of rows) {
    if (usedCharacters >= maxExcerptCharacters) break;
    const remaining = maxExcerptCharacters - usedCharacters;
    const content = row.content.slice(0, Math.min(AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS, remaining));
    selected.push({ ...row, content });
    usedCharacters += content.length;
  }
  return selected;
};

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

  async read(input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
    samplePolicy: AudiencePulseSamplePolicy;
  }): Promise<AudiencePulseHistorySnapshot> {
    // Aggregates remain exact in SQL. Node only receives a strict metadata reserve for
    // sampling, then text and answer windows for the final evidence set.
    const aggregateRows = await buildAudiencePulseAggregateQuery(this.db, input)
      .execute() as AudiencePulseAggregateRow[];
    const populationSize = Number(aggregateRows[0]?.population_size ?? "0");
    const weeklyVolume = aggregateRows.map((row) => ({
      weekStart: new Date(row.week_start).toISOString(),
      visitorQuestionCount: Number(row.visitor_question_count),
      conversationCount: Number(row.conversation_count),
    }));
    if (populationSize === 0) {
      return {
        period: { start: input.analysisStart, end: input.analysisEnd },
        coverage: { populationSize, sampleSize: 0, sampled: false },
        weeklyVolume,
        evidence: [],
      };
    }

    const candidates = await buildAudiencePulseBoundedCandidateQuery(this.db, input)
      .execute() as AudiencePulseEligibleQuestionMetadataRow[];
    const selectedMetadata = selectAudiencePulseSample(candidates, input.samplePolicy);
    const selectedRows = selectedMetadata.length === 0
      ? []
      : await buildAudiencePulseSelectedQuestionQuery(this.db, {
        ...input,
        messageIds: selectedMetadata.map((row) => row.id),
      }).execute() as AudiencePulseEligibleQuestionRow[];
    const selectedById = new Map(selectedRows.map((row) => [row.id, row]));
    // Preserve the sampler's round-robin order after the database IN query.
    const selected = boundAudiencePulseQuestionExcerpts(
      selectedMetadata.flatMap((row) => {
        const selectedRow = selectedById.get(row.id);
        return selectedRow ? [selectedRow] : [];
      }),
      input.samplePolicy.maxExcerptCharacters,
    );
    const answerWindows = await readAudiencePulseAnswerWindows(this.db, {
      workspaceId: input.workspaceId,
      analysisEnd: input.analysisEnd,
      questions: selected,
    });

    const evidence: AudiencePulseEvidence[] = selected.map((question, index) => {
      const answer = classifyAudiencePulseAnswerWindow(answerWindows.get(question.id) ?? []);
      return {
        id: `evidence-${index + 1}`,
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
        sampled: evidence.length < populationSize,
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
