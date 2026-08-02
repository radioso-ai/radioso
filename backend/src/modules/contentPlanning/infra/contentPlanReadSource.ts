import { CompiledQuery } from "kysely";

import type { Db } from "../../../shared/infra/kysely/types.js";
import type {
  ContentPlanCorpusState,
  ContentPlanEnrichmentState,
  ContentPlanProjectionState,
  ContentPlanRecommendationAction,
} from "../contracts/index.js";
import type { ContentPlanWindow } from "../domain/aggregationPolicy.js";

type DateValue = Date | string;

export interface ContentPlanProjectionReadSnapshot {
  coherentGenerationId: string | null;
  state: ContentPlanProjectionState;
  processedThrough: string | null;
  pendingEmbeddingCount: number;
  pendingAssignmentCount: number;
  pendingEnrichmentTopicCount: number;
  processedCount: number | null;
  totalCount: number | null;
  embeddingSpaceFingerprint: string | null;
  reason: string | null;
}

export interface ContentPlanReadTopic {
  id: string;
  lifecycle: "provisional" | "mature" | "merged" | "retired";
  representativeObservationIds: string[];
  revision: number;
  mergedIntoTopicId: string | null;
  redirectExpiresAt: string | null;
  updatedAt: string;
  enrichment: {
    state: ContentPlanEnrichmentState;
    sourceTopicRevision: number | null;
    label: string | null;
    description: string | null;
    suggestedTitle: string | null;
    rationale: string | null;
    questionsToAnswer: unknown;
    suggestedShape: string | null;
    evidenceStatement: string | null;
    persistedAction: ContentPlanRecommendationAction | null;
    actionRuleVersion: number;
    corpusState: ContentPlanCorpusState;
    publishedSourceEvidence: {
      memberCount: number;
      groundedCount: number;
      degradedCount: number;
      noSupportCount: number;
      notEvaluatedCount: number;
      credibleOpportunity: boolean;
    } | null;
    publishedSourceEvidenceStrength: "none" | "low" | "medium" | "high" | null;
    publishedSourceCorpusEvidenceFingerprint: string | null;
    updatedAt: string | null;
  };
}

export interface ContentPlanReadObservation {
  id: string;
  sourceUserMessageId: string;
  sourceAssistantMessageId: string;
  conversationId: string;
  observationState: "pending_context" | "ready";
  observedAt: string;
  question: string | null;
  agentName: string | null;
  topicId: string | null;
  topicLifecycle: "provisional" | "mature" | "merged" | "retired" | null;
  vectorState: string | null;
}

export interface ContentPlanReadDocument {
  topicId: string;
  id: string;
  title: string;
  updatedAt: string;
  possibleRelevance: number;
  existedBeforeGap: boolean;
  retrievedByGapAnswers: boolean;
  citedByGapAnswers: boolean;
  changedAfterGap: boolean;
}

export interface ContentPlanReportReadData {
  topics: ContentPlanReadTopic[];
  observations: ContentPlanReadObservation[];
  documents: ContentPlanReadDocument[];
}

export interface ContentPlanTopicRedirectNode {
  id: string;
  lifecycle: ContentPlanReadTopic["lifecycle"];
  mergedIntoTopicId: string | null;
  redirectExpiresAt: string | null;
}

export interface ContentPlanReadSourcePort {
  getProjection(workspaceId: string): Promise<ContentPlanProjectionReadSnapshot | null>;
  getReportData(
    workspaceId: string,
    generationId: string,
    window: ContentPlanWindow,
  ): Promise<ContentPlanReportReadData>;
  getTopicRedirectChain(
    workspaceId: string,
    generationId: string,
    topicId: string,
  ): Promise<ContentPlanTopicRedirectNode[]>;
  listTopicAssistantMessageIds(
    workspaceId: string,
    generationId: string,
    topicId: string,
    window: ContentPlanWindow,
  ): Promise<string[]>;
}

type ProjectionRow = {
  coherent_generation_id: string | null;
  projection_state: ContentPlanProjectionState;
  processed_through: DateValue | null;
  bootstrap_processed: number | string | null;
  bootstrap_total: number | string | null;
  reason: string | null;
  embedding_space_fingerprint: string | null;
  pending_embedding_count: number | string;
  pending_assignment_count: number | string;
  pending_enrichment_topic_count: number | string;
};

type TopicRow = {
  id: string;
  lifecycle: ContentPlanReadTopic["lifecycle"];
  representative_observation_ids: string[];
  revision: number | string;
  merged_into_topic_id: string | null;
  redirect_expires_at: DateValue | null;
  updated_at: DateValue;
  enrichment_state: ContentPlanEnrichmentState | null;
  source_topic_revision: number | string | null;
  label: string | null;
  description: string | null;
  suggested_title: string | null;
  rationale: string | null;
  questions_to_answer: unknown;
  suggested_shape: string | null;
  evidence_statement: string | null;
  persisted_action: ContentPlanRecommendationAction | null;
  action_rule_version: number | string | null;
  corpus_state: ContentPlanCorpusState | null;
  published_source_member_count: number | string | null;
  published_source_grounded_count: number | string | null;
  published_source_degraded_count: number | string | null;
  published_source_no_support_count: number | string | null;
  published_source_not_evaluated_count: number | string | null;
  published_source_credible_opportunity: boolean | null;
  published_source_evidence_strength: "none" | "low" | "medium" | "high" | null;
  published_source_corpus_evidence_fingerprint: string | null;
  enrichment_updated_at: DateValue | null;
};

type ObservationRow = {
  id: string;
  source_user_message_id: string;
  source_assistant_message_id: string;
  conversation_id: string;
  observation_state: ContentPlanReadObservation["observationState"];
  observed_at: DateValue;
  question: string | null;
  agent_name: string | null;
  topic_id: string | null;
  topic_lifecycle: ContentPlanReadObservation["topicLifecycle"];
  vector_state: string | null;
};

type DocumentRow = {
  topic_id: string;
  document_id: string;
  title: string;
  document_updated_at: DateValue;
  similarity: number | string;
  existed_before_gap: boolean;
  retrieved_by_gap_answers: boolean;
  cited_by_gap_answers: boolean;
  changed_after_gap: boolean;
};

type RedirectRow = {
  id: string;
  lifecycle: ContentPlanReadTopic["lifecycle"];
  merged_into_topic_id: string | null;
  redirect_expires_at: DateValue | null;
  depth: number | string;
};

type AssistantMessageRow = {
  source_assistant_message_id: string;
};

export class PostgresContentPlanReadSource implements ContentPlanReadSourcePort {
  constructor(private readonly db: Db) {}

  async getProjection(workspaceId: string): Promise<ContentPlanProjectionReadSnapshot | null> {
    const result = await this.db.executeQuery<ProjectionRow>(CompiledQuery.raw(
      `SELECT
         ps.coherent_generation_id,
         ps.projection_state,
         ps.processed_through,
         ps.bootstrap_processed,
         ps.bootstrap_total,
         ps.reason,
         work_space.identity_fingerprint AS embedding_space_fingerprint,
         COALESCE((
           SELECT COUNT(*)
           FROM content_plan_observation_vectors pending_vector
           WHERE pending_vector.workspace_id = ps.workspace_id
             AND pending_vector.generation_id = COALESCE(ps.target_generation_id, ps.coherent_generation_id)
             AND pending_vector.embedding IS NULL
             AND pending_vector.state IN ('pending_embedding', 'retryable')
         ), 0) AS pending_embedding_count,
         COALESCE((
           SELECT COUNT(*)
           FROM content_plan_observation_vectors pending_assignment
           WHERE pending_assignment.workspace_id = ps.workspace_id
             AND pending_assignment.generation_id = COALESCE(ps.target_generation_id, ps.coherent_generation_id)
             AND pending_assignment.embedding IS NOT NULL
             AND pending_assignment.state IN ('ready', 'processing', 'retryable')
         ), 0) AS pending_assignment_count,
         COALESCE((
           SELECT COUNT(*)
           FROM content_plan_topics pending_topic
           LEFT JOIN content_plan_topic_enrichments pending_enrichment
             ON pending_enrichment.workspace_id = pending_topic.workspace_id
            AND pending_enrichment.generation_id = pending_topic.generation_id
            AND pending_enrichment.topic_id = pending_topic.id
           WHERE pending_topic.workspace_id = ps.workspace_id
             AND pending_topic.generation_id = COALESCE(ps.target_generation_id, ps.coherent_generation_id)
             AND pending_topic.lifecycle = 'mature'
             AND (
               pending_enrichment.topic_id IS NULL
               OR pending_enrichment.state IN ('pending', 'stale')
             )
         ), 0) AS pending_enrichment_topic_count
       FROM content_plan_projection_states ps
       LEFT JOIN content_plan_projection_generations work_generation
         ON work_generation.workspace_id = ps.workspace_id
        AND work_generation.id = COALESCE(ps.target_generation_id, ps.coherent_generation_id)
       LEFT JOIN embedding_spaces work_space ON work_space.id = work_generation.embedding_space_id
       WHERE ps.workspace_id = $1`,
      [workspaceId],
    ));
    const row = result.rows[0];
    if (!row) return null;
    return {
      coherentGenerationId: row.coherent_generation_id,
      state: row.projection_state,
      processedThrough: nullableDate(row.processed_through),
      pendingEmbeddingCount: Number(row.pending_embedding_count),
      pendingAssignmentCount: Number(row.pending_assignment_count),
      pendingEnrichmentTopicCount: Number(row.pending_enrichment_topic_count),
      processedCount: nullableNumber(row.bootstrap_processed),
      totalCount: nullableNumber(row.bootstrap_total),
      embeddingSpaceFingerprint: row.embedding_space_fingerprint,
      reason: row.reason,
    };
  }

  async getReportData(
    workspaceId: string,
    generationId: string,
    window: ContentPlanWindow,
  ): Promise<ContentPlanReportReadData> {
    const [topicsResult, observationsResult, documentsResult] = await Promise.all([
      this.db.executeQuery<TopicRow>(CompiledQuery.raw(
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
         ORDER BY topic.id ASC`,
        [workspaceId, generationId],
      )),
      this.db.executeQuery<ObservationRow>(CompiledQuery.raw(
        `SELECT
           observation.id,
           observation.source_user_message_id,
           observation.source_assistant_message_id,
           observation.conversation_id,
           observation.observation_state,
           observation.observed_at,
           source_message.content AS question,
           agent.name AS agent_name,
           membership.topic_id,
           topic.lifecycle AS topic_lifecycle,
           vector.state AS vector_state
         FROM content_plan_observations observation
         LEFT JOIN messages source_message
           ON source_message.workspace_id = observation.workspace_id
          AND source_message.id = observation.source_user_message_id
         LEFT JOIN conversations conversation
           ON conversation.workspace_id = observation.workspace_id
          AND conversation.id = observation.conversation_id
         LEFT JOIN agents agent
           ON agent.workspace_id = observation.workspace_id
          AND agent.id = conversation.agent_id
         LEFT JOIN content_plan_topic_memberships membership
           ON membership.workspace_id = observation.workspace_id
          AND membership.generation_id = $2
          AND membership.observation_id = observation.id
         LEFT JOIN content_plan_topics topic
           ON topic.workspace_id = membership.workspace_id
          AND topic.generation_id = membership.generation_id
          AND topic.id = membership.topic_id
         LEFT JOIN content_plan_observation_vectors vector
           ON vector.workspace_id = observation.workspace_id
          AND vector.generation_id = $2
          AND vector.observation_id = observation.id
         WHERE observation.workspace_id = $1
           AND observation.observed_at >= $3::timestamptz
           AND observation.observed_at < $4::timestamptz
           AND observation.observation_state IN ('pending_context', 'ready')
         ORDER BY observation.observed_at ASC, observation.id ASC`,
        [workspaceId, generationId, window.from, window.to],
      )),
      this.db.executeQuery<DocumentRow>(CompiledQuery.raw(
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
         ORDER BY topic_document.topic_id ASC, topic_document.similarity DESC, topic_document.document_id ASC`,
        [workspaceId, generationId],
      )),
    ]);

    return {
      topics: topicsResult.rows.map(mapTopic),
      observations: observationsResult.rows.map(mapObservation),
      documents: documentsResult.rows.map(mapDocument),
    };
  }

  async getTopicRedirectChain(
    workspaceId: string,
    generationId: string,
    topicId: string,
  ): Promise<ContentPlanTopicRedirectNode[]> {
    const result = await this.db.executeQuery<RedirectRow>(CompiledQuery.raw(
      `WITH RECURSIVE topic_chain AS (
         SELECT
           topic.id,
           topic.lifecycle,
           topic.merged_into_topic_id,
           topic.redirect_expires_at,
           0 AS depth,
           ARRAY[topic.id]::uuid[] AS path
         FROM content_plan_topics topic
         WHERE topic.workspace_id = $1
           AND topic.generation_id = $2
           AND topic.id = $3

         UNION ALL

         SELECT
           target.id,
           target.lifecycle,
           target.merged_into_topic_id,
           target.redirect_expires_at,
           topic_chain.depth + 1,
           topic_chain.path || target.id
         FROM topic_chain
         JOIN content_plan_topics target
           ON target.workspace_id = $1
          AND target.generation_id = $2
          AND target.id = topic_chain.merged_into_topic_id
         WHERE topic_chain.lifecycle = 'merged'
           AND topic_chain.depth < 9
           AND NOT target.id = ANY(topic_chain.path)
       )
       SELECT id, lifecycle, merged_into_topic_id, redirect_expires_at, depth
       FROM topic_chain
       ORDER BY depth ASC`,
      [workspaceId, generationId, topicId],
    ));
    return result.rows.map((row) => ({
      id: row.id,
      lifecycle: row.lifecycle,
      mergedIntoTopicId: row.merged_into_topic_id,
      redirectExpiresAt: nullableDate(row.redirect_expires_at),
    }));
  }

  async listTopicAssistantMessageIds(
    workspaceId: string,
    generationId: string,
    topicId: string,
    window: ContentPlanWindow,
  ): Promise<string[]> {
    const result = await this.db.executeQuery<AssistantMessageRow>(CompiledQuery.raw(
      `SELECT observation.source_assistant_message_id
       FROM content_plan_topic_memberships membership
       JOIN content_plan_observations observation
         ON observation.workspace_id = membership.workspace_id
        AND observation.id = membership.observation_id
       WHERE membership.workspace_id = $1
         AND membership.generation_id = $2
         AND membership.topic_id = $3
         AND observation.observation_state = 'ready'
         AND observation.observed_at >= $4::timestamptz
         AND observation.observed_at < $5::timestamptz
       GROUP BY observation.source_assistant_message_id
       ORDER BY MAX(observation.observed_at) DESC, observation.source_assistant_message_id DESC`,
      [workspaceId, generationId, topicId, window.from, window.to],
    ));
    return result.rows.map((row) => row.source_assistant_message_id);
  }
}

const mapTopic = (row: TopicRow): ContentPlanReadTopic => ({
  id: row.id,
  lifecycle: row.lifecycle,
  representativeObservationIds: row.representative_observation_ids,
  revision: Number(row.revision),
  mergedIntoTopicId: row.merged_into_topic_id,
  redirectExpiresAt: nullableDate(row.redirect_expires_at),
  updatedAt: serializeDate(row.updated_at),
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
    actionRuleVersion: row.action_rule_version === null ? 1 : Number(row.action_rule_version),
    corpusState: row.corpus_state ?? "pending",
    publishedSourceEvidence: row.published_source_member_count === null
      ? null
      : {
          memberCount: Number(row.published_source_member_count),
          groundedCount: Number(row.published_source_grounded_count),
          degradedCount: Number(row.published_source_degraded_count),
          noSupportCount: Number(row.published_source_no_support_count),
          notEvaluatedCount: Number(row.published_source_not_evaluated_count),
          credibleOpportunity: row.published_source_credible_opportunity === true,
        },
    publishedSourceEvidenceStrength: row.published_source_evidence_strength,
    publishedSourceCorpusEvidenceFingerprint: row.published_source_corpus_evidence_fingerprint,
    updatedAt: nullableDate(row.enrichment_updated_at),
  },
});

const mapObservation = (row: ObservationRow): ContentPlanReadObservation => ({
  id: row.id,
  sourceUserMessageId: row.source_user_message_id,
  sourceAssistantMessageId: row.source_assistant_message_id,
  conversationId: row.conversation_id,
  observationState: row.observation_state,
  observedAt: serializeDate(row.observed_at),
  question: row.question,
  agentName: row.agent_name,
  topicId: row.topic_id,
  topicLifecycle: row.topic_lifecycle,
  vectorState: row.vector_state,
});

const mapDocument = (row: DocumentRow): ContentPlanReadDocument => ({
  topicId: row.topic_id,
  id: row.document_id,
  title: row.title,
  updatedAt: serializeDate(row.document_updated_at),
  possibleRelevance: Number(row.similarity),
  existedBeforeGap: row.existed_before_gap,
  retrievedByGapAnswers: row.retrieved_by_gap_answers,
  citedByGapAnswers: row.cited_by_gap_answers,
  changedAfterGap: row.changed_after_gap,
});

const serializeDate = (value: DateValue): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const nullableDate = (value: DateValue | null): string | null =>
  value === null ? null : serializeDate(value);

const nullableNumber = (value: number | string | null): number | null =>
  value === null ? null : Number(value);
