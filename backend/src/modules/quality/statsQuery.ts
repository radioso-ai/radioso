import type {
  QualitySignalId,
  QualityStatsBucket,
  QualityStatsMetric,
  QualityStatsRange,
  QualityStatsWindow,
} from "./contracts/index.js";
import { QUALITY_SIGNAL_IDS } from "./contracts/index.js";
import {
  QUALITY_SIGNAL_ACTIVE_TRIAGE_STATES,
  resolveQualitySignalPredicate,
  type GroundedOutcomeTuples,
} from "./domain/qualitySignals.js";
import {
  TRIAGE_JOIN,
  TURN_POPULATION_SOURCE,
  bindParam,
  buildActionTuplePredicate,
  buildAnyFeedbackExistsPredicate,
  buildFeedbackExistsPredicate,
  buildSignalPredicate,
  buildSkillStatusPredicate,
  buildTurnPopulationFilters,
  type SqlQuery,
  type TurnPopulationScope,
} from "./turnPopulationSql.js";
import { NEGATIVE_FEEDBACK_VALUES, SKILL_FAILURE_STATUSES } from "./domain/qualitySignals.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const RANGE_DAYS: Record<QualityStatsRange, number> = { "7d": 7, "30d": 30 };

export interface QualityStatsPeriod {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}

export interface QualityStatsWindows {
  current: QualityStatsPeriod;
  previous: QualityStatsPeriod;
  /**
   * Both windows as one contiguous period. A single daily-bucket query over this span
   * feeds `current`, `previous` and the buckets, so the three cannot disagree.
   */
  span: QualityStatsPeriod;
  /** UTC midnight for every day in the current window, ascending. */
  bucketStarts: Date[];
}

const startOfUtcDay = (value: Date): Date =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));

/**
 * Resolves the current window and the equal-length window immediately before it.
 *
 * The current window ends at the start of tomorrow (UTC) so today is a real, if partial,
 * bucket rather than being dropped. Both bounds land on UTC midnight, which keeps the
 * window an exact whole number of day buckets.
 */
export const resolveQualityStatsWindows = (
  range: QualityStatsRange,
  now: Date,
): QualityStatsWindows => {
  const days = RANGE_DAYS[range];
  const currentTo = new Date(startOfUtcDay(now).getTime() + DAY_MS);
  const currentFrom = new Date(currentTo.getTime() - days * DAY_MS);
  const previousFrom = new Date(currentFrom.getTime() - days * DAY_MS);

  const bucketStarts: Date[] = [];
  for (let index = 0; index < days; index += 1) {
    bucketStarts.push(new Date(currentFrom.getTime() + index * DAY_MS));
  }

  return {
    current: { from: currentFrom, to: currentTo },
    previous: { from: previousFrom, to: currentFrom },
    span: { from: previousFrom, to: currentTo },
    bucketStarts,
  };
};

/** Aggregate columns every stats query projects, selected as text to dodge int8-as-string. */
export interface QualityStatsAggregateRow {
  bucket_start?: Date | string | null;
  turn_count: string | number;
  grounded_count: string | number;
  grounding_gap_count: string | number;
  negative_feedback_count: string | number;
  rated_count: string | number;
  skill_failure_count: string | number;
}

export type QualityBacklogRow = Record<QualitySignalId, string | number>;

const toNumber = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** A rate is only meaningful over a non-empty population; zero denominators report null. */
const toMetric = (count: number, denominator: number): QualityStatsMetric => ({
  count,
  denominator,
  rate: denominator === 0 ? null : count / denominator,
});

const formatUtcDate = (value: Date): string => value.toISOString().slice(0, 10);

const emptyMetric = (): QualityStatsMetric => ({ count: 0, denominator: 0, rate: null });

export const buildEmptyQualityStatsBuckets = (windows: QualityStatsWindows): QualityStatsBucket[] =>
  windows.bucketStarts.map((start) => ({
    date: formatUtcDate(start),
    turnCount: 0,
    grounded: emptyMetric(),
    negativeFeedback: emptyMetric(),
    skillFailures: emptyMetric(),
  }));

const metricsFromRow = (row: QualityStatsAggregateRow) => {
  const turnCount = toNumber(row.turn_count);
  const grounded = toNumber(row.grounded_count);
  const gaps = toNumber(row.grounding_gap_count);
  return {
    turnCount,
    grounded: toMetric(grounded, grounded + gaps),
    negativeFeedback: toMetric(toNumber(row.negative_feedback_count), toNumber(row.rated_count)),
    skillFailures: toMetric(toNumber(row.skill_failure_count), turnCount),
  };
};

/** Every count column the aggregate projection emits. All of them are per-turn counts. */
const AGGREGATE_COUNT_COLUMNS = [
  "turn_count",
  "grounded_count",
  "grounding_gap_count",
  "negative_feedback_count",
  "rated_count",
  "skill_failure_count",
] as const;

const emptyAggregateRow = (): QualityStatsAggregateRow => ({
  turn_count: 0,
  grounded_count: 0,
  grounding_gap_count: 0,
  negative_feedback_count: 0,
  rated_count: 0,
  skill_failure_count: 0,
});

export const toQualityStatsWindow = (
  period: QualityStatsPeriod,
  row: QualityStatsAggregateRow | undefined,
): QualityStatsWindow => ({
  from: period.from.toISOString(),
  to: period.to.toISOString(),
  ...metricsFromRow(row ?? emptyAggregateRow()),
});

const toBucketDate = (value: Date | string | null | undefined): Date | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const bucketKey = (value: Date | string | null | undefined): string | null => {
  const date = toBucketDate(value);
  return date === null ? null : formatUtcDate(date);
};

/**
 * Folds aggregate rows onto their UTC day. Days with no rows keep their zero fill, and
 * rows outside the window are dropped rather than extending it.
 */
export const mergeQualityStatsBuckets = (
  buckets: QualityStatsBucket[],
  rows: readonly QualityStatsAggregateRow[],
): QualityStatsBucket[] => {
  const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));

  for (const row of rows) {
    const key = bucketKey(row.bucket_start);
    const bucket = key === null ? undefined : byDate.get(key);
    if (!bucket) {
      continue;
    }
    byDate.set(key!, { date: bucket.date, ...metricsFromRow(row) });
  }

  return buckets.map((bucket) => byDate.get(bucket.date)!);
};

/**
 * Sums per-day aggregate rows into a single row.
 *
 * Sound because every turn falls in exactly one UTC day and every projected column is a
 * count of turns, so the columns are additive. Rates are deliberately NOT summed or
 * averaged: `metricsFromRow` recomputes each one from the summed count and denominator, so
 * a quiet day cannot weigh as much as a busy one.
 */
export const sumQualityStatsRows = (
  rows: readonly QualityStatsAggregateRow[],
): QualityStatsAggregateRow => {
  const total = emptyAggregateRow();
  for (const row of rows) {
    for (const column of AGGREGATE_COUNT_COLUMNS) {
      total[column] = toNumber(total[column]) + toNumber(row[column]);
    }
  }
  return total;
};

/** Daily rows whose UTC day starts inside the period: inclusive from, exclusive to. */
const rowsWithinPeriod = (
  rows: readonly QualityStatsAggregateRow[],
  period: QualityStatsPeriod,
): QualityStatsAggregateRow[] =>
  rows.filter((row) => {
    const start = toBucketDate(row.bucket_start);
    return start !== null && start >= period.from && start < period.to;
  });

/**
 * A window summarised from the daily buckets rather than its own aggregate query.
 *
 * One query spanning both windows means `current`, `previous` and `buckets` are consistent
 * by construction. Four independent statements under READ COMMITTED each see their own
 * snapshot, so a turn written mid-response could be counted by one and missed by another —
 * a response whose buckets do not sum to its own total.
 */
export const summarizeQualityStatsWindow = (
  period: QualityStatsPeriod,
  dailyRows: readonly QualityStatsAggregateRow[],
): QualityStatsWindow =>
  toQualityStatsWindow(period, sumQualityStatsRows(rowsWithinPeriod(dailyRows, period)));

export interface QualityStatsQueryInput extends TurnPopulationScope {
  window: QualityStatsPeriod;
  tuples: GroundedOutcomeTuples;
}

/**
 * The aggregate projection shared by the window and per-day queries. Every count is a
 * `FILTER` over one scan of the turn population, and every feedback count is a correlated
 * EXISTS, so a turn with several votes still counts once.
 */
const buildAggregateProjection = (tuples: GroundedOutcomeTuples, params: unknown[]): string => {
  const grounded = buildActionTuplePredicate(tuples.grounded, params);
  const gaps = buildActionTuplePredicate(tuples.gaps, params);
  const negative = buildFeedbackExistsPredicate(NEGATIVE_FEEDBACK_VALUES, params);
  const rated = buildAnyFeedbackExistsPredicate();
  const failures = buildSkillStatusPredicate(SKILL_FAILURE_STATUSES, params);

  return `COUNT(*)::text AS turn_count,
         COUNT(*) FILTER (WHERE ${grounded})::text AS grounded_count,
         COUNT(*) FILTER (WHERE ${gaps})::text AS grounding_gap_count,
         COUNT(*) FILTER (WHERE ${negative})::text AS negative_feedback_count,
         COUNT(*) FILTER (WHERE ${rated})::text AS rated_count,
         COUNT(*) FILTER (WHERE ${failures})::text AS skill_failure_count`;
};

const buildWindowFilters = (input: QualityStatsQueryInput, params: unknown[]): string[] => {
  const filters = buildTurnPopulationFilters(input, params);
  filters.push(`m.created_at >= ${bindParam(params, input.window.from.toISOString())}::timestamptz`);
  filters.push(`m.created_at < ${bindParam(params, input.window.to.toISOString())}::timestamptz`);
  return filters;
};

/**
 * Per-UTC-day aggregates over the window. This is the only windowed statement the stats
 * endpoint issues: run over the span of both windows, its rows sum to `current` and
 * `previous` as well as filling the buckets.
 */
export const buildQualityStatsDailyQuery = (input: QualityStatsQueryInput): SqlQuery => {
  const params: unknown[] = [];
  const filters = buildWindowFilters(input, params);
  const projection = buildAggregateProjection(input.tuples, params);

  return {
    // The trailing `AT TIME ZONE 'UTC'` converts the truncated naive timestamp back to a
    // timestamptz. Without it the driver reads the bare timestamp as local wall time and
    // every bucket lands on the wrong day outside UTC.
    text: `SELECT
         date_trunc('day', m.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start,
         ${projection}
       ${TURN_POPULATION_SOURCE}
       WHERE ${filters.join("\n         AND ")}
       GROUP BY bucket_start
       ORDER BY bucket_start ASC`,
    params,
  };
};

export interface QualityBacklogQueryInput extends TurnPopulationScope {
  tuples: GroundedOutcomeTuples;
}

/**
 * All-time active-triage counts, one column per signal. Deliberately range-independent:
 * the backlog is what the operator still has to work through, and an untriaged turn does
 * not stop mattering because it aged out of the health window.
 */
export const buildQualityStatsBacklogQuery = (input: QualityBacklogQueryInput): SqlQuery => {
  const params: unknown[] = [];
  const filters = buildTurnPopulationFilters(input, params);
  filters.push(
    `COALESCE(tr.state, 'open') = ANY(${bindParam(params, [...QUALITY_SIGNAL_ACTIVE_TRIAGE_STATES])}::text[])`,
  );

  const projections = QUALITY_SIGNAL_IDS.map((signal) =>
    `COUNT(*) FILTER (WHERE ${buildSignalPredicate(
      resolveQualitySignalPredicate(signal, input.tuples),
      params,
    )})::text AS ${signal}`,
  );

  return {
    text: `SELECT
         ${projections.join(",\n         ")}
       ${TURN_POPULATION_SOURCE}
       ${TRIAGE_JOIN}
       WHERE ${filters.join("\n         AND ")}`,
    params,
  };
};
