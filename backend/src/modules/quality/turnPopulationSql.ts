import { OPERATOR_TEST_SOURCE_CHANNELS } from "../../shared/domain/conversationSource.js";
import { HUMAN_AUTHORED_MESSAGE_SOURCES } from "../../shared/domain/messageAuthorship.js";
import type { QualityActionFilter, QualityFeedbackValue } from "./contracts/index.js";
import type { QualitySignalPredicate } from "./domain/qualitySignals.js";

export interface SqlQuery {
  text: string;
  params: unknown[];
}

/** Appends a bind value and returns its positional placeholder. */
export const bindParam = (params: unknown[], value: unknown): string => {
  params.push(value);
  return `$${params.length}`;
};

/**
 * The turn population every quality read selects from: assistant turns in one
 * workspace, joined to their conversation for agent and channel attribution.
 *
 * `/quality/turns` and `/quality/stats` MUST share this, or a signal's count and the
 * rows behind it come from different populations.
 */
export const TURN_POPULATION_SOURCE = `FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.workspace_id = m.workspace_id`;

/**
 * Turn latency, resolved from the column first and the turn's `chat.answer` audit event only
 * as a fallback.
 *
 * Migration 131 added `messages.total_latency_ms` and backfilled history, so the column
 * covers all but a narrow set of rows: turns written during a rolling deploy where the
 * migration had landed but the write path had not, and any turn whose audit event carried a
 * latency shape the backfill declined to trust.
 *
 * The fallback is a correlated subquery nested in `COALESCE`, deliberately NOT a lateral
 * join. `COALESCE` evaluates only the arguments needed to determine its result, so the
 * `audit_events` probe genuinely does not run for the rows that already have a persisted
 * value. A `LEFT JOIN LATERAL ... ON TRUE` probes every row in the population regardless of
 * whether its value is needed, which on a workspace with a large migrated backlog is one
 * index probe and JSONB walk per turn on every dashboard refresh. Guarding a join in its
 * `ON` clause or inner `WHERE` does not reliably avoid that.
 *
 * Source precedence is identical to migration 131's backfill, and must stay that way: the two
 * candidates are different quantities, so diverging here would make a fallback row and a
 * backfilled row report different things under one column name.
 *
 *   1. `activityTrace.stages[stageId='answer'].durationMs` — turn wall time, the same value
 *      the write path persists to `messages.total_latency_ms`.
 *   2. `activityTrace.totalDurationMs` — retrieval-pipeline time only, and 0 for turns that
 *      skipped retrieval. Kept solely for traces old enough to predate the answer stage.
 *
 * `jsonb_typeof` guards both: a missing or non-numeric value yields NULL instead of raising
 * on the cast. The CASE around the array walk is load-bearing — `jsonb_array_elements` raises
 * on a non-array argument, so the type test has to gate whether the subquery runs at all.
 */
export const RESOLVED_LATENCY_EXPRESSION = `COALESCE(m.total_latency_ms, (
         SELECT COALESCE(
           CASE
             WHEN jsonb_typeof(ae.metadata_json #> '{activityTrace,stages}') = 'array'
               THEN (
                 SELECT (stage ->> 'durationMs')::numeric::int
                 FROM jsonb_array_elements(ae.metadata_json #> '{activityTrace,stages}') AS stage
                 WHERE stage ->> 'stageId' = 'answer'
                   AND jsonb_typeof(stage -> 'durationMs') = 'number'
                 LIMIT 1
               )
             ELSE NULL
           END,
           CASE
             WHEN jsonb_typeof(ae.metadata_json #> '{activityTrace,totalDurationMs}') = 'number'
               THEN ((ae.metadata_json #>> '{activityTrace,totalDurationMs}')::numeric)::int
             ELSE NULL
           END
         )
         FROM audit_events ae
         WHERE ae.workspace_id = m.workspace_id
           AND ae.event_type = 'chat.answer'
           AND ae.metadata_json ->> 'assistantMessageId' = m.id::text
         ORDER BY ae.created_at DESC, ae.id DESC
         LIMIT 1
       ))`;

export const TRIAGE_JOIN = `LEFT JOIN assistant_answer_triage tr
         ON tr.workspace_id = m.workspace_id AND tr.assistant_message_id = m.id`;

interface EffectiveTriageSqlOptions {
  messageAlias?: string;
  triageAlias?: string;
  latestDownUpdatedAtExpression?: string;
}

/**
 * Persisted terminal triage is superseded when a newer thumbs-down arrives.
 *
 * List queries can pass their already-computed latest-down expression. Other
 * reads use a correlated EXISTS so Postgres can stop at the first fresh vote
 * and avoids a feedback fan-out or an unconditional aggregate per turn.
 */
export const buildEffectiveOpenPredicate = (
  options: EffectiveTriageSqlOptions = {},
): string => {
  const messageAlias = options.messageAlias ?? "m";
  const triageAlias = options.triageAlias ?? "tr";
  const freshNegativeFeedback = options.latestDownUpdatedAtExpression
    ? `${options.latestDownUpdatedAtExpression} IS NOT NULL
             AND ${options.latestDownUpdatedAtExpression} > ${triageAlias}.updated_at`
    : `EXISTS (
             SELECT 1
             FROM assistant_answer_feedback feedback_freshness
             WHERE feedback_freshness.workspace_id = ${messageAlias}.workspace_id
               AND feedback_freshness.assistant_message_id = ${messageAlias}.id
               AND feedback_freshness.value = 'down'
               AND feedback_freshness.updated_at > ${triageAlias}.updated_at
           )`;

  return `${triageAlias}.state IN ('resolved', 'dismissed')
           AND ${freshNegativeFeedback}`;
};

export const buildEffectiveTriageStateExpression = (
  options: EffectiveTriageSqlOptions = {},
): string => {
  const triageAlias = options.triageAlias ?? "tr";
  return `CASE
         WHEN ${buildEffectiveOpenPredicate(options)} THEN 'open'
         ELSE COALESCE(${triageAlias}.state, 'open')
       END`;
};

export interface TurnPopulationScope {
  workspaceId: string;
  agentId?: string;
  channel?: string;
}

/**
 * The predicate that defines which turns are AI-quality turns at all. Everything else a
 * quality query adds is a filter layered on top of this.
 */
export const buildTurnPopulationFilters = (
  scope: TurnPopulationScope,
  params: unknown[],
): string[] => {
  const filters = [
    `m.workspace_id = ${bindParam(params, scope.workspaceId)}`,
    "m.role = 'assistant'",
  ];

  // Operator-driven test traffic (dashboard test chat, workbench replay) never counts as a
  // real quality signal, so it is excluded unconditionally. NULL-safe: `NOT IN` yields NULL
  // (not TRUE) for NULL source rows, which would wrongly drop real conversations.
  const channelPlaceholders = OPERATOR_TEST_SOURCE_CHANNELS.map((channel) =>
    bindParam(params, channel),
  );
  filters.push(
    `(c.source_channel IS NULL OR c.source_channel NOT IN (${channelPlaceholders.join(", ")}))`,
  );

  // Operator takeover replies are stored with `role = 'assistant'` but a human source, and
  // carry no skill outcome or model latency. Counting them as AI turns inflates volume and
  // depresses every rate in any workspace that uses handoff. Same NULL-safety as above:
  // rows predating the `source` column are AI-authored.
  const sourcePlaceholders = HUMAN_AUTHORED_MESSAGE_SOURCES.map((source) =>
    bindParam(params, source),
  );
  filters.push(`(m.source IS NULL OR m.source NOT IN (${sourcePlaceholders.join(", ")}))`);

  if (scope.agentId) {
    filters.push(`c.agent_id = ${bindParam(params, scope.agentId)}`);
  }

  if (scope.channel) {
    filters.push(`c.source_channel = ${bindParam(params, scope.channel)}`);
  }

  return filters;
};

/**
 * Matches a turn against `(skillName, outcome)` tuples. Empty tuple sets yield an
 * unsatisfiable predicate, which is the honest answer when the catalog marks nothing.
 */
export const buildActionTuplePredicate = (
  actions: readonly QualityActionFilter[],
  params: unknown[],
): string => {
  const skillsParam = bindParam(params, actions.map((action) => action.skillName));
  const outcomesParam = bindParam(params, actions.map((action) => action.outcome));
  return `EXISTS (
           SELECT 1
           FROM unnest(${skillsParam}::text[], ${outcomesParam}::text[]) AS t(skill_name, outcome)
           WHERE t.skill_name = m.skill_name AND t.outcome = m.skill_outcome
         )`;
};

/**
 * Whether the turn carries at least one of the given feedback values. Correlated EXISTS
 * rather than a join, so a turn with three down-votes counts once.
 */
export const buildFeedbackExistsPredicate = (
  values: readonly QualityFeedbackValue[],
  params: unknown[],
): string =>
  `EXISTS (
           SELECT 1 FROM assistant_answer_feedback f
           WHERE f.assistant_message_id = m.id
             AND f.value = ANY(${bindParam(params, [...values])}::text[])
         )`;

/** Whether the turn carries any feedback at all — the denominator for feedback rates. */
export const buildAnyFeedbackExistsPredicate = (): string =>
  `EXISTS (
           SELECT 1 FROM assistant_answer_feedback f
           WHERE f.assistant_message_id = m.id
         )`;

export const buildSkillStatusPredicate = (
  statuses: readonly string[],
  params: unknown[],
): string => `m.skill_status = ANY(${bindParam(params, [...statuses])}::text[])`;

/** Turns a signal's domain meaning into SQL over the shared turn population. */
export const buildSignalPredicate = (
  predicate: QualitySignalPredicate,
  params: unknown[],
): string => {
  switch (predicate.kind) {
    case "feedback":
      return buildFeedbackExistsPredicate(predicate.values, params);
    case "actions":
      return buildActionTuplePredicate(predicate.actions, params);
    case "skillStatuses":
      return buildSkillStatusPredicate(predicate.statuses, params);
  }
};

/**
 * Matches a turn carrying any of the given signals.
 *
 * Every per-signal predicate is a scalar test or a correlated EXISTS over the row already
 * in scope, so OR-ing them narrows the same single scan of the turn population rather than
 * fanning it out: a turn that is both down-voted and missing grounding is still exactly one
 * row. A join or `UNION ALL` per signal would duplicate it, which is why neither is used.
 */
export const buildAnySignalPredicate = (
  predicates: readonly QualitySignalPredicate[],
  params: unknown[],
): string => {
  const clauses = predicates.map((predicate) => buildSignalPredicate(predicate, params));
  // A single signal emits exactly the predicate it always did — no wrapper, so the
  // one-signal query is byte-identical to the pre-list behaviour.
  return clauses.length === 1 ? clauses[0]! : `(${clauses.join("\n           OR ")})`;
};
