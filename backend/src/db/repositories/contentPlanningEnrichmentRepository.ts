import type {
  ContentPlanEnrichmentRepositoryPort,
  ContentPlanEnrichmentSourceEvidence,
  ContentPlanTopicDocumentInput,
  ContentPlanTopicEnrichmentRecord,
} from "../../modules/contentPlanning/contracts/persistence.js";
import {
  MAX_CONTENT_PLAN_CLAIM_BATCH,
  MAX_CONTENT_PLAN_RELATED_DOCUMENTS,
} from "../../modules/contentPlanning/contracts/persistence.js";
import {
  createClaimLease,
  currentTimestamp,
  toJsonb,
} from "../../shared/infra/kysely/sqlHelpers.js";
import type { JsonValue } from "../../shared/infra/kysely/schema.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface EnrichmentRow {
  workspace_id: string;
  generation_id: string;
  topic_id: string;
  source_topic_revision: number;
  source_member_count: number;
  source_grounded_count: number;
  source_degraded_count: number;
  source_no_support_count: number;
  source_not_evaluated_count: number;
  source_credible_opportunity: boolean;
  source_evidence_strength: string;
  source_corpus_evidence_fingerprint: string | null;
  published_source_member_count: number | null;
  published_source_grounded_count: number | null;
  published_source_degraded_count: number | null;
  published_source_no_support_count: number | null;
  published_source_not_evaluated_count: number | null;
  published_source_credible_opportunity: boolean | null;
  published_source_evidence_strength: string | null;
  published_source_corpus_evidence_fingerprint: string | null;
  analysis_mode: string;
  publish_state: string;
  state: string;
  label: string | null;
  description: string | null;
  suggested_title: string | null;
  rationale: string | null;
  questions_to_answer: JsonValue | null;
  suggested_shape: string | null;
  evidence_statement: string | null;
  action: string | null;
  action_rule_version: number;
  corpus_state: string;
  corpus_checked_at: Date | null;
  available_at: Date;
  attempt_count: number;
  claim_token: string | null;
  claim_expires_at: Date | null;
  failure_stage: string | null;
  failure_reason: string | null;
  enriched_at: Date | null;
  updated_at: Date;
}

const enrichmentColumns = [
  "workspace_id",
  "generation_id",
  "topic_id",
  "source_topic_revision",
  "source_member_count",
  "source_grounded_count",
  "source_degraded_count",
  "source_no_support_count",
  "source_not_evaluated_count",
  "source_credible_opportunity",
  "source_evidence_strength",
  "source_corpus_evidence_fingerprint",
  "published_source_member_count",
  "published_source_grounded_count",
  "published_source_degraded_count",
  "published_source_no_support_count",
  "published_source_not_evaluated_count",
  "published_source_credible_opportunity",
  "published_source_evidence_strength",
  "published_source_corpus_evidence_fingerprint",
  "analysis_mode",
  "publish_state",
  "state",
  "label",
  "description",
  "suggested_title",
  "rationale",
  "questions_to_answer",
  "suggested_shape",
  "evidence_statement",
  "action",
  "action_rule_version",
  "corpus_state",
  "corpus_checked_at",
  "available_at",
  "attempt_count",
  "claim_token",
  "claim_expires_at",
  "failure_stage",
  "failure_reason",
  "enriched_at",
  "updated_at",
] as const;

const parseQuestions = (value: JsonValue | null): string[] | null => {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((question) => typeof question !== "string")) {
    throw new Error("Stored content planning questions have an invalid representation");
  }
  return value as string[];
};

const mapPublishedEvidence = (row: EnrichmentRow): ContentPlanEnrichmentSourceEvidence | null =>
  row.published_source_member_count === null
    ? null
    : {
        memberCount: row.published_source_member_count,
        groundedCount: row.published_source_grounded_count!,
        degradedCount: row.published_source_degraded_count!,
        noSupportCount: row.published_source_no_support_count!,
        notEvaluatedCount: row.published_source_not_evaluated_count!,
        credibleOpportunity: row.published_source_credible_opportunity!,
      };

const mapEnrichment = (row: EnrichmentRow): ContentPlanTopicEnrichmentRecord => ({
  workspaceId: row.workspace_id,
  generationId: row.generation_id,
  topicId: row.topic_id,
  sourceTopicRevision: row.source_topic_revision,
  sourceEvidence: {
    memberCount: row.source_member_count,
    groundedCount: row.source_grounded_count,
    degradedCount: row.source_degraded_count,
    noSupportCount: row.source_no_support_count,
    notEvaluatedCount: row.source_not_evaluated_count,
    credibleOpportunity: row.source_credible_opportunity,
  },
  publishedSourceEvidence: mapPublishedEvidence(row),
  sourceEvidenceStrength: row.source_evidence_strength as ContentPlanTopicEnrichmentRecord["sourceEvidenceStrength"],
  publishedSourceEvidenceStrength: row.published_source_evidence_strength as ContentPlanTopicEnrichmentRecord["publishedSourceEvidenceStrength"],
  sourceCorpusEvidenceFingerprint: row.source_corpus_evidence_fingerprint,
  publishedSourceCorpusEvidenceFingerprint: row.published_source_corpus_evidence_fingerprint,
  analysisMode: row.analysis_mode as ContentPlanTopicEnrichmentRecord["analysisMode"],
  publishState: row.publish_state as ContentPlanTopicEnrichmentRecord["publishState"],
  state: row.state as ContentPlanTopicEnrichmentRecord["state"],
  label: row.label,
  description: row.description,
  suggestedTitle: row.suggested_title,
  rationale: row.rationale,
  questionsToAnswer: parseQuestions(row.questions_to_answer),
  suggestedShape: row.suggested_shape as ContentPlanTopicEnrichmentRecord["suggestedShape"],
  evidenceStatement: row.evidence_statement,
  action: row.action as ContentPlanTopicEnrichmentRecord["action"],
  actionRuleVersion: row.action_rule_version,
  corpusState: row.corpus_state as ContentPlanTopicEnrichmentRecord["corpusState"],
  corpusCheckedAt: row.corpus_checked_at ? new Date(row.corpus_checked_at) : null,
  availableAt: new Date(row.available_at),
  attemptCount: row.attempt_count,
  claimToken: row.claim_token,
  claimExpiresAt: row.claim_expires_at ? new Date(row.claim_expires_at) : null,
  failureStage: row.failure_stage,
  failureReason: row.failure_reason,
  enrichedAt: row.enriched_at ? new Date(row.enriched_at) : null,
  updatedAt: new Date(row.updated_at),
});

type QueueEnrichmentInput = Parameters<ContentPlanEnrichmentRepositoryPort["queueEnrichment"]>[0];

const hasSameQueuedSnapshot = (
  row: EnrichmentRow,
  input: QueueEnrichmentInput,
): boolean => row.source_topic_revision === input.sourceTopicRevision
  && row.source_member_count === input.sourceEvidence.memberCount
  && row.source_grounded_count === input.sourceEvidence.groundedCount
  && row.source_degraded_count === input.sourceEvidence.degradedCount
  && row.source_no_support_count === input.sourceEvidence.noSupportCount
  && row.source_not_evaluated_count === input.sourceEvidence.notEvaluatedCount
  && row.source_credible_opportunity === input.sourceEvidence.credibleOpportunity
  && row.source_evidence_strength === input.sourceEvidenceStrength
  && row.source_corpus_evidence_fingerprint === input.sourceCorpusEvidenceFingerprint
  && row.analysis_mode === input.analysisMode
  && row.publish_state === input.publishState
  && row.action_rule_version === input.actionRuleVersion;

const carriesUnpublishedDebounce = (row: EnrichmentRow): boolean =>
  row.state === "pending" || (row.state === "stale" && row.enriched_at === null);

const earliestDate = (left: Date, right: Date): Date =>
  left.getTime() <= right.getTime() ? left : right;

export class ContentPlanEnrichmentRepository implements ContentPlanEnrichmentRepositoryPort {
  constructor(private readonly db: Db) {}

  async queueEnrichment(
    input: QueueEnrichmentInput,
  ): Promise<ContentPlanTopicEnrichmentRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      const topic = await trx
        .selectFrom("content_plan_topics")
        .select(["revision", "lifecycle"])
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "=", input.topicId)
        .forUpdate()
        .executeTakeFirst();
      if (!topic || topic.lifecycle !== "mature" || topic.revision !== input.sourceTopicRevision) return null;
      const existing = await trx
        .selectFrom("content_plan_topic_enrichments")
        .select(enrichmentColumns)
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("topic_id", "=", input.topicId)
        .forUpdate()
        .executeTakeFirst();
      if (existing && hasSameQueuedSnapshot(existing as EnrichmentRow, input)) {
        if (new Date(existing.available_at).getTime() <= input.availableAt.getTime()) {
          return mapEnrichment(existing as EnrichmentRow);
        }
        const earlier = await trx
          .updateTable("content_plan_topic_enrichments")
          .set({
            available_at: input.availableAt,
            updated_at: currentTimestamp(),
          })
          .where("workspace_id", "=", input.workspaceId)
          .where("generation_id", "=", input.generationId)
          .where("topic_id", "=", input.topicId)
          .returning(enrichmentColumns)
          .executeTakeFirstOrThrow();
        return mapEnrichment(earlier as EnrichmentRow);
      }

      // A stream of newer observations must replace the queued snapshot without
      // restarting its bounded debounce. Ready/outside-cap output and terminal
      // unavailable/stale output begin a distinct scheduling cycle instead.
      const availableAt = existing && carriesUnpublishedDebounce(existing as EnrichmentRow)
        ? earliestDate(new Date(existing.available_at), input.availableAt)
        : input.availableAt;
      const queuedValues = {
        workspace_id: input.workspaceId,
        generation_id: input.generationId,
        topic_id: input.topicId,
        source_topic_revision: input.sourceTopicRevision,
        source_member_count: input.sourceEvidence.memberCount,
        source_grounded_count: input.sourceEvidence.groundedCount,
        source_degraded_count: input.sourceEvidence.degradedCount,
        source_no_support_count: input.sourceEvidence.noSupportCount,
        source_not_evaluated_count: input.sourceEvidence.notEvaluatedCount,
        source_credible_opportunity: input.sourceEvidence.credibleOpportunity,
        source_evidence_strength: input.sourceEvidenceStrength,
        source_corpus_evidence_fingerprint: input.sourceCorpusEvidenceFingerprint,
        analysis_mode: input.analysisMode,
        publish_state: input.publishState,
        state: "pending",
        action_rule_version: input.actionRuleVersion,
        available_at: availableAt,
      } as const;
      const row = existing
        ? await trx
          .updateTable("content_plan_topic_enrichments")
          .set({
            source_topic_revision: input.sourceTopicRevision,
            source_member_count: input.sourceEvidence.memberCount,
            source_grounded_count: input.sourceEvidence.groundedCount,
            source_degraded_count: input.sourceEvidence.degradedCount,
            source_no_support_count: input.sourceEvidence.noSupportCount,
            source_not_evaluated_count: input.sourceEvidence.notEvaluatedCount,
            source_credible_opportunity: input.sourceEvidence.credibleOpportunity,
            source_evidence_strength: input.sourceEvidenceStrength,
            source_corpus_evidence_fingerprint: input.sourceCorpusEvidenceFingerprint,
            analysis_mode: input.analysisMode,
            publish_state: input.publishState,
            state: "pending",
            action_rule_version: input.actionRuleVersion,
            available_at: availableAt,
            attempt_count: 0,
            claim_token: null,
            claim_expires_at: null,
            failure_stage: null,
            failure_reason: null,
            updated_at: currentTimestamp(),
          })
          .where("workspace_id", "=", input.workspaceId)
          .where("generation_id", "=", input.generationId)
          .where("topic_id", "=", input.topicId)
          .returning(enrichmentColumns)
          .executeTakeFirstOrThrow()
        : await trx
          .insertInto("content_plan_topic_enrichments")
          .values(queuedValues)
          .returning(enrichmentColumns)
          .executeTakeFirstOrThrow();
      return mapEnrichment(row as EnrichmentRow);
    });
  }

  async rebasePublishedEnrichment(
    input: Parameters<ContentPlanEnrichmentRepositoryPort["rebasePublishedEnrichment"]>[0],
  ): Promise<ContentPlanTopicEnrichmentRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      const topic = await trx
        .selectFrom("content_plan_topics")
        .select(["revision", "lifecycle"])
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "=", input.topicId)
        .forUpdate()
        .executeTakeFirst();
      if (!topic || topic.lifecycle !== "mature" || topic.revision !== input.sourceTopicRevision) {
        return null;
      }
      const existing = await trx
        .selectFrom("content_plan_topic_enrichments")
        .select(enrichmentColumns)
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("topic_id", "=", input.topicId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !existing
        || existing.published_source_member_count === null
        || existing.enriched_at === null
      ) return null;

      const row = await trx
        .updateTable("content_plan_topic_enrichments")
        .set({
          source_topic_revision: input.sourceTopicRevision,
          source_member_count: input.sourceEvidence.memberCount,
          source_grounded_count: input.sourceEvidence.groundedCount,
          source_degraded_count: input.sourceEvidence.degradedCount,
          source_no_support_count: input.sourceEvidence.noSupportCount,
          source_not_evaluated_count: input.sourceEvidence.notEvaluatedCount,
          source_credible_opportunity: input.sourceEvidence.credibleOpportunity,
          source_evidence_strength: input.sourceEvidenceStrength,
          source_corpus_evidence_fingerprint: input.sourceCorpusEvidenceFingerprint,
          analysis_mode: input.analysisMode,
          publish_state: input.publishState,
          state: input.publishState,
          attempt_count: 0,
          claim_token: null,
          claim_expires_at: null,
          failure_stage: null,
          failure_reason: null,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("topic_id", "=", input.topicId)
        .returning(enrichmentColumns)
        .executeTakeFirstOrThrow();
      return mapEnrichment(row as EnrichmentRow);
    });
  }

  async claimEnrichmentBatch(input: {
    workspaceId?: string;
    generationId?: string;
    limit: number;
    now: Date;
    leaseMs: number;
  }): Promise<ContentPlanTopicEnrichmentRecord[]> {
    const lease = createClaimLease({ ...input, maxLimit: MAX_CONTENT_PLAN_CLAIM_BATCH });
    return this.db.transaction().execute(async (trx) => {
      let query = trx
        .selectFrom("content_plan_topic_enrichments")
        .select(enrichmentColumns)
        .where((eb) => eb.or([
          eb("state", "=", "pending"),
          eb.and([
            eb("state", "=", "stale"),
            eb("failure_stage", "is", null),
            eb("failure_reason", "is", null),
          ]),
        ]))
        .where("available_at", "<=", input.now)
        .where((eb) => eb.or([
          eb("claim_token", "is", null),
          eb("claim_expires_at", "<=", input.now),
        ]))
        .where((eb) => eb.exists(
          eb.selectFrom("content_plan_topics")
            .select("id")
            .whereRef("content_plan_topics.workspace_id", "=", "content_plan_topic_enrichments.workspace_id")
            .whereRef("content_plan_topics.generation_id", "=", "content_plan_topic_enrichments.generation_id")
            .whereRef("content_plan_topics.id", "=", "content_plan_topic_enrichments.topic_id")
            .whereRef("content_plan_topics.revision", "=", "content_plan_topic_enrichments.source_topic_revision")
            .where("content_plan_topics.lifecycle", "=", "mature"),
        ));
      if (input.workspaceId) query = query.where("workspace_id", "=", input.workspaceId);
      if (input.generationId) query = query.where("generation_id", "=", input.generationId);
      const selected = await query
        .orderBy("available_at", "asc")
        .orderBy("topic_id", "asc")
        .forUpdate()
        .skipLocked()
        .limit(input.limit)
        .execute();
      if (selected.length === 0) return [];
      const rows = await trx
        .updateTable("content_plan_topic_enrichments")
        .set((eb) => ({
          attempt_count: eb("attempt_count", "+", 1),
          claim_token: lease.token,
          claim_expires_at: lease.expiresAt,
          failure_stage: null,
          failure_reason: null,
          updated_at: input.now,
        }))
        .where((eb) => eb.or(selected.map((row) => eb.and([
          eb("workspace_id", "=", row.workspace_id),
          eb("generation_id", "=", row.generation_id),
          eb("topic_id", "=", row.topic_id),
        ]))))
        .returning(enrichmentColumns)
        .execute();
      const order = new Map(selected.map((row, index) => [
        `${row.workspace_id}:${row.generation_id}:${row.topic_id}`,
        index,
      ]));
      return rows
        .sort((left, right) =>
          order.get(`${left.workspace_id}:${left.generation_id}:${left.topic_id}`)!
          - order.get(`${right.workspace_id}:${right.generation_id}:${right.topic_id}`)!)
        .map((row) => mapEnrichment(row as EnrichmentRow));
    });
  }

  async markOutsideAnalysisCap(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    sourceEvidence: ContentPlanEnrichmentSourceEvidence;
    sourceEvidenceStrength: ContentPlanTopicEnrichmentRecord["sourceEvidenceStrength"];
    sourceCorpusEvidenceFingerprint: string | null;
    actionRuleVersion: number;
    availableAt: Date;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const topic = await trx
        .selectFrom("content_plan_topics")
        .select(["revision", "lifecycle"])
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "=", input.topicId)
        .forUpdate()
        .executeTakeFirst();
      if (!topic || topic.lifecycle !== "mature" || topic.revision !== input.sourceTopicRevision) {
        return false;
      }
      await trx
        .insertInto("content_plan_topic_enrichments")
        .values({
          workspace_id: input.workspaceId,
          generation_id: input.generationId,
          topic_id: input.topicId,
          source_topic_revision: input.sourceTopicRevision,
          source_member_count: input.sourceEvidence.memberCount,
          source_grounded_count: input.sourceEvidence.groundedCount,
          source_degraded_count: input.sourceEvidence.degradedCount,
          source_no_support_count: input.sourceEvidence.noSupportCount,
          source_not_evaluated_count: input.sourceEvidence.notEvaluatedCount,
          source_credible_opportunity: input.sourceEvidence.credibleOpportunity,
          source_evidence_strength: input.sourceEvidenceStrength,
          source_corpus_evidence_fingerprint: input.sourceCorpusEvidenceFingerprint,
          analysis_mode: "label_only",
          publish_state: "outside_analysis_cap",
          state: "outside_analysis_cap",
          action_rule_version: input.actionRuleVersion,
          available_at: input.availableAt,
        })
        .onConflict((conflict) => conflict
          .columns(["workspace_id", "generation_id", "topic_id"])
          .doUpdateSet({
            source_topic_revision: input.sourceTopicRevision,
            source_member_count: input.sourceEvidence.memberCount,
            source_grounded_count: input.sourceEvidence.groundedCount,
            source_degraded_count: input.sourceEvidence.degradedCount,
            source_no_support_count: input.sourceEvidence.noSupportCount,
            source_not_evaluated_count: input.sourceEvidence.notEvaluatedCount,
            source_credible_opportunity: input.sourceEvidence.credibleOpportunity,
            source_evidence_strength: input.sourceEvidenceStrength,
            source_corpus_evidence_fingerprint: input.sourceCorpusEvidenceFingerprint,
            analysis_mode: "label_only",
            publish_state: "outside_analysis_cap",
            state: "outside_analysis_cap",
            suggested_title: null,
            rationale: null,
            questions_to_answer: null,
            suggested_shape: null,
            evidence_statement: null,
            action: null,
            action_rule_version: input.actionRuleVersion,
            available_at: input.availableAt,
            claim_token: null,
            claim_expires_at: null,
            failure_stage: null,
            failure_reason: null,
            updated_at: currentTimestamp(),
          }))
        .execute();
      return true;
    });
  }

  async failEnrichmentClaim(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    claimToken: string;
    terminal: boolean;
    failureStage: string;
    failureReason: string;
    availableAt: Date;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("content_plan_topic_enrichments")
        .select(["source_topic_revision", "claim_token", "enriched_at"])
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("topic_id", "=", input.topicId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !row
        || row.source_topic_revision !== input.sourceTopicRevision
        || row.claim_token !== input.claimToken
      ) return false;
      const topic = await trx
        .selectFrom("content_plan_topics")
        .select("revision")
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "=", input.topicId)
        .executeTakeFirst();
      if (!topic || topic.revision !== input.sourceTopicRevision) return false;
      const result = await trx
        .updateTable("content_plan_topic_enrichments")
        .set({
          state: input.terminal ? (row.enriched_at ? "stale" : "unavailable") : "pending",
          available_at: input.availableAt,
          claim_token: null,
          claim_expires_at: null,
          failure_stage: input.failureStage,
          failure_reason: input.failureReason,
          updated_at: currentTimestamp(),
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("topic_id", "=", input.topicId)
        .where("source_topic_revision", "=", input.sourceTopicRevision)
        .where("claim_token", "=", input.claimToken)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    });
  }

  async publishEnrichment(input: Parameters<ContentPlanEnrichmentRepositoryPort["publishEnrichment"]>[0]): Promise<boolean> {
    const result = await this.db
      .updateTable("content_plan_topic_enrichments")
      .set((eb) => ({
        state: input.publishState,
        source_member_count: input.sourceEvidence.memberCount,
        source_grounded_count: input.sourceEvidence.groundedCount,
        source_degraded_count: input.sourceEvidence.degradedCount,
        source_no_support_count: input.sourceEvidence.noSupportCount,
        source_not_evaluated_count: input.sourceEvidence.notEvaluatedCount,
        source_credible_opportunity: input.sourceEvidence.credibleOpportunity,
        source_corpus_evidence_fingerprint: input.sourceCorpusEvidenceFingerprint,
        published_source_member_count: eb.ref("source_member_count"),
        published_source_grounded_count: eb.ref("source_grounded_count"),
        published_source_degraded_count: eb.ref("source_degraded_count"),
        published_source_no_support_count: eb.ref("source_no_support_count"),
        published_source_not_evaluated_count: eb.ref("source_not_evaluated_count"),
        published_source_credible_opportunity: eb.ref("source_credible_opportunity"),
        published_source_evidence_strength: eb.ref("source_evidence_strength"),
        published_source_corpus_evidence_fingerprint: input.sourceCorpusEvidenceFingerprint,
        label: input.label,
        description: input.description,
        suggested_title: input.suggestedTitle,
        rationale: input.rationale,
        questions_to_answer: input.questionsToAnswer === null ? null : toJsonb(input.questionsToAnswer),
        suggested_shape: input.suggestedShape,
        evidence_statement: input.evidenceStatement,
        action: input.action,
        action_rule_version: input.actionRuleVersion,
        corpus_state: input.corpusState,
        corpus_checked_at: input.corpusCheckedAt,
        claim_token: null,
        claim_expires_at: null,
        failure_stage: null,
        failure_reason: null,
        enriched_at: input.enrichedAt,
        updated_at: currentTimestamp(),
      }))
      .where("workspace_id", "=", input.workspaceId)
      .where("generation_id", "=", input.generationId)
      .where("topic_id", "=", input.topicId)
      .where("source_topic_revision", "=", input.sourceTopicRevision)
      .where("source_member_count", "=", input.sourceEvidence.memberCount)
      .where("source_grounded_count", "=", input.sourceEvidence.groundedCount)
      .where("source_degraded_count", "=", input.sourceEvidence.degradedCount)
      .where("source_no_support_count", "=", input.sourceEvidence.noSupportCount)
      .where("source_not_evaluated_count", "=", input.sourceEvidence.notEvaluatedCount)
      .where("source_credible_opportunity", "=", input.sourceEvidence.credibleOpportunity)
      .where("publish_state", "=", input.publishState)
      .where("claim_token", "=", input.claimToken)
      .where((eb) => eb.exists(
        eb.selectFrom("content_plan_topics")
          .select("id")
          .whereRef("content_plan_topics.workspace_id", "=", "content_plan_topic_enrichments.workspace_id")
          .whereRef("content_plan_topics.generation_id", "=", "content_plan_topic_enrichments.generation_id")
          .whereRef("content_plan_topics.id", "=", "content_plan_topic_enrichments.topic_id")
          .where("content_plan_topics.revision", "=", input.sourceTopicRevision),
      ))
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async replaceTopicDocuments(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    documents: readonly ContentPlanTopicDocumentInput[];
  }): Promise<{ applied: boolean; storedCount: number; truncatedCount: number }> {
    const unique = [...new Map(input.documents.map((document) => [document.documentId, document])).values()];
    const selected = unique.slice(0, MAX_CONTENT_PLAN_RELATED_DOCUMENTS);
    return this.db.transaction().execute(async (trx) => {
      const topic = await trx
        .selectFrom("content_plan_topics")
        .select("revision")
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("id", "=", input.topicId)
        .forUpdate()
        .executeTakeFirst();
      if (!topic || topic.revision !== input.sourceTopicRevision) {
        return { applied: false, storedCount: 0, truncatedCount: unique.length - selected.length };
      }
      await trx
        .deleteFrom("content_plan_topic_documents")
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .where("topic_id", "=", input.topicId)
        .execute();
      if (selected.length > 0) {
        await trx
          .insertInto("content_plan_topic_documents")
          .values(selected.map((document) => ({
            workspace_id: input.workspaceId,
            generation_id: input.generationId,
            topic_id: input.topicId,
            document_id: document.documentId,
            source_topic_revision: input.sourceTopicRevision,
            similarity: document.similarity,
            existed_before_gap: document.existedBeforeGap,
            retrieved_by_gap_answers: document.retrievedByGapAnswers,
            cited_by_gap_answers: document.citedByGapAnswers,
            changed_after_gap: document.changedAfterGap,
          })))
          .execute();
      }
      return {
        applied: true,
        storedCount: selected.length,
        truncatedCount: unique.length - selected.length,
      };
    });
  }

}
