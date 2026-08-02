import { CompiledQuery } from "kysely";

import type { Db } from "../../../shared/infra/kysely/types.js";
import type {
  ContentPlanEnrichmentPlanningDataSourcePort,
} from "../services/enrichmentPlanningService.js";
import type { ContentPlanEnrichmentPlanningObservation } from "../services/enrichmentPlanningAccumulator.js";
import { CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1 } from "../services/enrichmentScheduler.js";
import type {
  ContentPlanReadDocument,
  ContentPlanReadTopic,
} from "./contentPlanReadSource.js";

const PERSISTED_FRONTIER_LIMIT =
  CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1.generatedBriefCap + 1;
const PERSISTED_IN_CAP_LIMIT =
  CONTENT_PLAN_ENRICHMENT_SCHEDULING_POLICY_V1.generatedBriefCap;

type DateValue = Date | string;

interface CandidateRow {
  topic_id: string;
}

interface RepairCursorRow {
  after_topic_id: string | null;
  version: number;
}

interface TopicRow {
  id: string;
  lifecycle: ContentPlanReadTopic["lifecycle"];
  representative_observation_ids: string[];
  revision: number | string;
  merged_into_topic_id: string | null;
  redirect_expires_at: DateValue | null;
  updated_at: DateValue;
  enrichment_state: ContentPlanReadTopic["enrichment"]["state"] | null;
  source_topic_revision: number | string | null;
  label: string | null;
  description: string | null;
  suggested_title: string | null;
  rationale: string | null;
  questions_to_answer: unknown;
  suggested_shape: string | null;
  evidence_statement: string | null;
  persisted_action: ContentPlanReadTopic["enrichment"]["persistedAction"];
  action_rule_version: number | string | null;
  corpus_state: ContentPlanReadTopic["enrichment"]["corpusState"] | null;
  published_source_member_count: number | string | null;
  published_source_grounded_count: number | string | null;
  published_source_degraded_count: number | string | null;
  published_source_no_support_count: number | string | null;
  published_source_not_evaluated_count: number | string | null;
  published_source_credible_opportunity: boolean | null;
  published_source_evidence_strength:
    ContentPlanReadTopic["enrichment"]["publishedSourceEvidenceStrength"];
  published_source_corpus_evidence_fingerprint: string | null;
  enrichment_updated_at: DateValue | null;
}

interface ObservationRow {
  id: string;
  source_user_message_id: string;
  source_assistant_message_id: string;
  conversation_id: string;
  observed_at: DateValue;
  topic_id: string;
}

interface DocumentRow {
  topic_id: string;
  document_id: string;
  title: string;
  document_updated_at: DateValue;
  similarity: number | string;
  existed_before_gap: boolean;
  retrieved_by_gap_answers: boolean;
  cited_by_gap_answers: boolean;
  changed_after_gap: boolean;
}

export class PostgresContentPlanEnrichmentPlanningDataSource
implements ContentPlanEnrichmentPlanningDataSourcePort {
  constructor(private readonly db: Db) {}

  async loadData(
    input: Parameters<ContentPlanEnrichmentPlanningDataSourcePort["loadData"]>[0],
  ): Promise<Awaited<ReturnType<ContentPlanEnrichmentPlanningDataSourcePort["loadData"]>>> {
    const hotTopicIds = await this.loadHotTopicIds(input);
    const repairState = input.repair ? await this.loadRepairState(input) : null;
    const repairTopicIds = input.repair && repairState
      ? await this.loadRepairTopicIds(input, repairState.afterTopicId)
      : [];
    const topicIds = [...new Set([...hotTopicIds, ...repairTopicIds])];
    const data = await this.loadSelectedData(input, topicIds);
    return {
      ...data,
      repairCheckpoint: input.repair && repairState
        ? {
            expectedVersion: repairState.version,
            nextTopicId: repairTopicIds.length === input.repair.limit
              ? repairTopicIds.at(-1) ?? null
              : null,
          }
        : null,
    };
  }

  async pageObservations(
    input: Parameters<ContentPlanEnrichmentPlanningDataSourcePort["pageObservations"]>[0],
  ): Promise<Awaited<ReturnType<ContentPlanEnrichmentPlanningDataSourcePort["pageObservations"]>>> {
    if (input.topicIds.length === 0) return { items: [], nextCursor: null };
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new Error("Content planning enrichment observation page limit must be between 1 and 500");
    }
    const result = await this.db.executeQuery<ObservationRow>(CompiledQuery.raw(
      `WITH unique_observations AS (
         SELECT DISTINCT ON (membership.topic_id, observation.source_user_message_id)
           observation.id,
           observation.source_user_message_id,
           observation.source_assistant_message_id,
           observation.conversation_id,
           observation.observed_at,
           membership.topic_id
         FROM content_plan_topic_memberships membership
         JOIN content_plan_observations observation
           ON observation.workspace_id = membership.workspace_id
          AND observation.id = membership.observation_id
         WHERE membership.workspace_id = $1
           AND membership.generation_id = $2
           AND membership.topic_id = ANY($3::uuid[])
           AND membership.assigned_at < $5::timestamptz
           AND observation.observed_at >= $4::timestamptz
           AND observation.observed_at < $5::timestamptz
           AND observation.observation_state = 'ready'
         ORDER BY membership.topic_id, observation.source_user_message_id,
                  observation.observed_at ASC, observation.id ASC
       )
       SELECT
         id,
         source_user_message_id,
         source_assistant_message_id,
         conversation_id,
         observed_at,
         topic_id
       FROM unique_observations
       WHERE (
         $6::timestamptz IS NULL
         OR observed_at > $6::timestamptz
         OR (observed_at = $6::timestamptz AND id > $7::uuid)
       )
       ORDER BY observed_at ASC, id ASC
       LIMIT $8`,
      [
        input.workspaceId,
        input.generationId,
        [...new Set(input.topicIds)],
        input.window.from,
        input.window.to,
        input.cursor?.observedAt ?? null,
        input.cursor?.observationId ?? null,
        input.limit + 1,
      ],
    ));
    const hasNext = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit);
    const items = rows.map(mapObservation);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasNext && last
        ? { observedAt: last.observedAt, observationId: last.id }
        : null,
    };
  }

  async completeRepairPage(
    input: Parameters<ContentPlanEnrichmentPlanningDataSourcePort["completeRepairPage"]>[0],
  ): Promise<boolean> {
    const result = input.checkpoint.expectedVersion === 0
      ? await this.db.executeQuery<{ applied: number }>(CompiledQuery.raw(
        `INSERT INTO content_plan_enrichment_repair_cursors (
           workspace_id, generation_id, after_topic_id, version
         ) VALUES ($1, $2, $3, 1)
         ON CONFLICT DO NOTHING
         RETURNING 1 AS applied`,
        [input.workspaceId, input.generationId, input.checkpoint.nextTopicId],
      ))
      : await this.db.executeQuery<{ applied: number }>(CompiledQuery.raw(
        `UPDATE content_plan_enrichment_repair_cursors
         SET after_topic_id = $3, version = version + 1, updated_at = NOW()
         WHERE workspace_id = $1 AND generation_id = $2 AND version = $4
         RETURNING 1 AS applied`,
        [
          input.workspaceId,
          input.generationId,
          input.checkpoint.nextTopicId,
          input.checkpoint.expectedVersion,
        ],
      ));
    return result.rows.length === 1;
  }

  private async loadHotTopicIds(
    input: Parameters<ContentPlanEnrichmentPlanningDataSourcePort["loadData"]>[0],
  ): Promise<string[]> {
    const result = await this.db.executeQuery<CandidateRow>(CompiledQuery.raw(
      `WITH persisted_frontier AS (
         SELECT topic.id AS topic_id
         FROM content_plan_topics topic
         JOIN content_plan_topic_enrichments enrichment
           ON enrichment.workspace_id = topic.workspace_id
          AND enrichment.generation_id = topic.generation_id
          AND enrichment.topic_id = topic.id
         WHERE topic.workspace_id = $1
           AND topic.generation_id = $2
           AND topic.lifecycle = 'mature'
           AND topic.created_at < $6::timestamptz
           AND (
             enrichment.source_credible_opportunity = TRUE
             OR enrichment.published_source_credible_opportunity = TRUE
           )
         ORDER BY
           GREATEST(
             enrichment.source_no_support_count,
             COALESCE(enrichment.published_source_no_support_count, 0)
           ) DESC,
           GREATEST(
             enrichment.source_degraded_count,
             COALESCE(enrichment.published_source_degraded_count, 0)
           ) DESC,
           GREATEST(
             enrichment.source_member_count,
             COALESCE(enrichment.published_source_member_count, 0)
           ) DESC,
           topic.id ASC
         LIMIT $4
       ), persisted_in_cap AS (
         SELECT topic.id AS topic_id
         FROM content_plan_topics topic
         JOIN content_plan_topic_enrichments enrichment
           ON enrichment.workspace_id = topic.workspace_id
          AND enrichment.generation_id = topic.generation_id
          AND enrichment.topic_id = topic.id
         WHERE topic.workspace_id = $1
           AND topic.generation_id = $2
           AND topic.lifecycle = 'mature'
           AND topic.created_at < $6::timestamptz
           AND enrichment.suggested_title IS NOT NULL
           AND enrichment.rationale IS NOT NULL
           AND enrichment.questions_to_answer IS NOT NULL
           AND enrichment.suggested_shape IS NOT NULL
           AND enrichment.evidence_statement IS NOT NULL
         ORDER BY enrichment.updated_at DESC, topic.id ASC
         LIMIT $5
       ), selected AS (
         SELECT UNNEST($3::uuid[]) AS topic_id
         UNION
         SELECT topic_id FROM persisted_frontier
         UNION
         SELECT topic_id FROM persisted_in_cap
       )
       SELECT selected.topic_id
       FROM selected
       JOIN content_plan_topics topic
         ON topic.workspace_id = $1
        AND topic.generation_id = $2
        AND topic.id = selected.topic_id
        AND topic.lifecycle = 'mature'
        AND topic.created_at < $6::timestamptz
       ORDER BY selected.topic_id`,
      [
        input.workspaceId,
        input.generationId,
        [...new Set(input.dirtyTopicIds)],
        PERSISTED_FRONTIER_LIMIT,
        PERSISTED_IN_CAP_LIMIT,
        input.window.to,
      ],
    ));
    return result.rows.map((row) => row.topic_id);
  }

  private async loadRepairState(
    input: Parameters<ContentPlanEnrichmentPlanningDataSourcePort["loadData"]>[0],
  ): Promise<{ afterTopicId: string | null; version: number }> {
    const result = await this.db.executeQuery<RepairCursorRow>(CompiledQuery.raw(
      `SELECT after_topic_id, version
       FROM content_plan_enrichment_repair_cursors
       WHERE workspace_id = $1 AND generation_id = $2`,
      [input.workspaceId, input.generationId],
    ));
    const row = result.rows[0];
    return row
      ? { afterTopicId: row.after_topic_id, version: Number(row.version) }
      : { afterTopicId: null, version: 0 };
  }

  private async loadRepairTopicIds(
    input: Parameters<ContentPlanEnrichmentPlanningDataSourcePort["loadData"]>[0],
    afterTopicId: string | null,
  ): Promise<string[]> {
    if (!input.repair) return [];
    const result = await this.db.executeQuery<CandidateRow>(CompiledQuery.raw(
      `SELECT id AS topic_id
       FROM content_plan_topics
       WHERE workspace_id = $1
         AND generation_id = $2
         AND lifecycle = 'mature'
         AND ($3::uuid IS NULL OR id > $3::uuid)
         AND created_at < $5::timestamptz
       ORDER BY id ASC
       LIMIT $4`,
      [
        input.workspaceId,
        input.generationId,
        afterTopicId,
        input.repair.limit,
        input.window.to,
      ],
    ));
    return result.rows.map((row) => row.topic_id);
  }

  private async loadSelectedData(
    input: Parameters<ContentPlanEnrichmentPlanningDataSourcePort["loadData"]>[0],
    topicIds: readonly string[],
  ): Promise<{ topics: ContentPlanReadTopic[]; documents: ContentPlanReadDocument[] }> {
    if (topicIds.length === 0) return { topics: [], documents: [] };
    const [topics, documents] = await Promise.all([
      this.loadTopics(input.workspaceId, input.generationId, topicIds, input.window.to),
      this.loadDocuments(input.workspaceId, input.generationId, topicIds),
    ]);
    return { topics, documents };
  }

  private async loadTopics(
    workspaceId: string,
    generationId: string,
    topicIds: readonly string[],
    windowTo: string,
  ): Promise<ContentPlanReadTopic[]> {
    const result = await this.db.executeQuery<TopicRow>(CompiledQuery.raw(
      `SELECT
         topic.id,
         topic.lifecycle,
         topic.representative_observation_ids,
         topic.revision,
         topic.merged_into_topic_id,
         topic.redirect_expires_at,
         topic.updated_at,
         enrichment.state AS enrichment_state,
         enrichment.source_topic_revision,
         enrichment.label,
         enrichment.description,
         enrichment.suggested_title,
         enrichment.rationale,
         enrichment.questions_to_answer,
         enrichment.suggested_shape,
         enrichment.evidence_statement,
         enrichment.action AS persisted_action,
         enrichment.action_rule_version,
         enrichment.corpus_state,
         enrichment.published_source_member_count,
         enrichment.published_source_grounded_count,
         enrichment.published_source_degraded_count,
         enrichment.published_source_no_support_count,
         enrichment.published_source_not_evaluated_count,
         enrichment.published_source_credible_opportunity,
         enrichment.published_source_evidence_strength,
         enrichment.published_source_corpus_evidence_fingerprint,
         enrichment.updated_at AS enrichment_updated_at
       FROM content_plan_topics topic
       LEFT JOIN content_plan_topic_enrichments enrichment
         ON enrichment.workspace_id = topic.workspace_id
        AND enrichment.generation_id = topic.generation_id
        AND enrichment.topic_id = topic.id
       WHERE topic.workspace_id = $1
         AND topic.generation_id = $2
         AND topic.id = ANY($3::uuid[])
         AND topic.lifecycle = 'mature'
         AND topic.created_at < $4::timestamptz
       ORDER BY topic.id ASC`,
      [workspaceId, generationId, topicIds, windowTo],
    ));
    return result.rows.map(mapTopic);
  }

  private async loadDocuments(
    workspaceId: string,
    generationId: string,
    topicIds: readonly string[],
  ): Promise<ContentPlanReadDocument[]> {
    const result = await this.db.executeQuery<DocumentRow>(CompiledQuery.raw(
      `SELECT
         topic_document.topic_id,
         topic_document.document_id,
         document.title,
         document.updated_at AS document_updated_at,
         topic_document.similarity,
         topic_document.existed_before_gap,
         topic_document.retrieved_by_gap_answers,
         topic_document.cited_by_gap_answers,
         topic_document.changed_after_gap
       FROM content_plan_topic_documents topic_document
       JOIN content_plan_topics topic
         ON topic.workspace_id = topic_document.workspace_id
        AND topic.generation_id = topic_document.generation_id
        AND topic.id = topic_document.topic_id
        AND topic.revision = topic_document.source_topic_revision
       JOIN documents document
         ON document.workspace_id = topic_document.workspace_id
        AND document.id = topic_document.document_id
       WHERE topic_document.workspace_id = $1
         AND topic_document.generation_id = $2
         AND topic_document.topic_id = ANY($3::uuid[])
       ORDER BY topic_document.topic_id ASC, topic_document.similarity DESC,
                topic_document.document_id ASC`,
      [workspaceId, generationId, topicIds],
    ));
    return result.rows.map(mapDocument);
  }
}

const mapTopic = (row: TopicRow): ContentPlanReadTopic => ({
  id: row.id,
  lifecycle: row.lifecycle,
  representativeObservationIds: row.representative_observation_ids,
  revision: Number(row.revision),
  mergedIntoTopicId: row.merged_into_topic_id,
  redirectExpiresAt: nullableDate(row.redirect_expires_at),
  updatedAt: requiredDate(row.updated_at),
  enrichment: {
    state: row.enrichment_state ?? "pending",
    sourceTopicRevision: nullableNumber(row.source_topic_revision),
    label: row.label,
    description: row.description,
    suggestedTitle: row.suggested_title,
    rationale: row.rationale,
    questionsToAnswer: row.questions_to_answer,
    suggestedShape: row.suggested_shape,
    evidenceStatement: row.evidence_statement,
    persistedAction: row.persisted_action,
    actionRuleVersion: Number(row.action_rule_version ?? 1),
    corpusState: row.corpus_state ?? "pending",
    publishedSourceEvidence: row.published_source_member_count === null
      ? null
      : {
          memberCount: Number(row.published_source_member_count),
          groundedCount: Number(row.published_source_grounded_count),
          degradedCount: Number(row.published_source_degraded_count),
          noSupportCount: Number(row.published_source_no_support_count),
          notEvaluatedCount: Number(row.published_source_not_evaluated_count),
          credibleOpportunity: row.published_source_credible_opportunity!,
        },
    publishedSourceEvidenceStrength: row.published_source_evidence_strength,
    publishedSourceCorpusEvidenceFingerprint: row.published_source_corpus_evidence_fingerprint,
    updatedAt: nullableDate(row.enrichment_updated_at),
  },
});

const mapObservation = (row: ObservationRow): ContentPlanEnrichmentPlanningObservation => ({
  id: row.id,
  sourceUserMessageId: row.source_user_message_id,
  sourceAssistantMessageId: row.source_assistant_message_id,
  conversationId: row.conversation_id,
  observedAt: requiredDate(row.observed_at),
  topicId: row.topic_id,
});

const mapDocument = (row: DocumentRow): ContentPlanReadDocument => ({
  topicId: row.topic_id,
  id: row.document_id,
  title: row.title,
  updatedAt: requiredDate(row.document_updated_at),
  possibleRelevance: Number(row.similarity),
  existedBeforeGap: row.existed_before_gap,
  retrievedByGapAnswers: row.retrieved_by_gap_answers,
  citedByGapAnswers: row.cited_by_gap_answers,
  changedAfterGap: row.changed_after_gap,
});

const requiredDate = (value: DateValue): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const nullableDate = (value: DateValue | null): string | null =>
  value === null ? null : requiredDate(value);

const nullableNumber = (value: number | string | null): number | null =>
  value === null ? null : Number(value);
