import { describe, expect, it } from "vitest";

import { resolveGroundedOutcomeTuples } from "../../src/modules/quality/domain/qualitySignals.js";
import {
  buildEmptyQualityStatsBuckets,
  buildQualityResolutionBreakdownQuery,
  buildQualityStatsBacklogQuery,
  buildQualityStatsDailyQuery,
  mergeQualityStatsBuckets,
  resolveQualityStatsWindows,
  sumQualityStatsRows,
  summarizeQualityStatsWindow,
  toQualityStatsWindow,
} from "../../src/modules/quality/statsQuery.js";
import {
  buildEffectiveOpenPredicate,
  buildEffectiveTriageStateExpression,
} from "../../src/modules/quality/turnPopulationSql.js";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";

const TUPLES = resolveGroundedOutcomeTuples([
  {
    name: "retrieval.answer",
    outcomes: [
      { name: "grounded", groundedAnswer: true },
      { name: "no_context", groundedAnswer: false },
    ],
  },
]);

const emptyRow = {
  turn_count: "0",
  grounded_count: "0",
  grounding_gap_count: "0",
  negative_feedback_count: "0",
  rated_count: "0",
  skill_failure_count: "0",
};

describe("effective triage SQL", () => {
  it("reuses a supplied latest-down aggregate and remains false rather than null without feedback", () => {
    const predicate = buildEffectiveOpenPredicate({
      latestDownUpdatedAtExpression: "feedback_activity.latest_down_updated_at",
    });

    expect(predicate).toContain("tr.state IN ('resolved', 'dismissed')");
    expect(predicate).toContain("feedback_activity.latest_down_updated_at IS NOT NULL");
    expect(predicate).toContain("feedback_activity.latest_down_updated_at > tr.updated_at");
  });

  it("uses a non-fan-out freshness probe when no aggregate is already available", () => {
    const expression = buildEffectiveTriageStateExpression();

    expect(expression).toContain("THEN 'open'");
    expect(expression).toContain("EXISTS (");
    expect(expression).not.toMatch(/JOIN\s+assistant_answer_feedback/);
    expect(expression).toContain("feedback_freshness.updated_at > tr.updated_at");
  });
});

describe("resolveQualityStatsWindows", () => {
  it("ends the current window at the start of the next UTC day so today is included", () => {
    const windows = resolveQualityStatsWindows("7d", new Date("2026-07-28T13:45:00.000Z"));

    expect(windows.current.from.toISOString()).toBe("2026-07-22T00:00:00.000Z");
    expect(windows.current.to.toISOString()).toBe("2026-07-29T00:00:00.000Z");
  });

  it("places the previous window immediately before the current one, at equal length", () => {
    const windows = resolveQualityStatsWindows("7d", new Date("2026-07-28T13:45:00.000Z"));

    expect(windows.previous.to.toISOString()).toBe(windows.current.from.toISOString());
    expect(windows.previous.from.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(windows.previous.to.getTime() - windows.previous.from.getTime()).toBe(
      windows.current.to.getTime() - windows.current.from.getTime(),
    );
  });

  it("exposes both windows as one contiguous span for a single daily query", () => {
    const windows = resolveQualityStatsWindows("7d", new Date("2026-07-28T13:45:00.000Z"));

    expect(windows.span.from.toISOString()).toBe(windows.previous.from.toISOString());
    expect(windows.span.to.toISOString()).toBe(windows.current.to.toISOString());
    expect(windows.span.to.getTime() - windows.span.from.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("spans thirty UTC days for the 30d range", () => {
    const windows = resolveQualityStatsWindows("30d", new Date("2026-01-15T00:30:00.000Z"));

    expect(windows.current.from.toISOString()).toBe("2025-12-17T00:00:00.000Z");
    expect(windows.current.to.toISOString()).toBe("2026-01-16T00:00:00.000Z");
    expect(windows.bucketStarts).toHaveLength(30);
  });

  it("emits one bucket start per UTC day, ascending, across a month boundary", () => {
    const windows = resolveQualityStatsWindows("7d", new Date("2026-03-02T23:59:59.999Z"));

    expect(windows.bucketStarts.map((date) => date.toISOString().slice(0, 10))).toEqual([
      "2026-02-24",
      "2026-02-25",
      "2026-02-26",
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });
});

describe("buildEmptyQualityStatsBuckets", () => {
  it("zero-fills every day in the current window", () => {
    const windows = resolveQualityStatsWindows("7d", new Date("2026-07-28T13:45:00.000Z"));
    const buckets = buildEmptyQualityStatsBuckets(windows);

    expect(buckets).toHaveLength(7);
    expect(buckets[0]).toEqual({
      date: "2026-07-22",
      turnCount: 0,
      grounded: { count: 0, denominator: 0, rate: null },
      negativeFeedback: { count: 0, denominator: 0, rate: null },
      skillFailures: { count: 0, denominator: 0, rate: null },
    });
    expect(buckets.at(-1)?.date).toBe("2026-07-28");
  });
});

describe("mergeQualityStatsBuckets", () => {
  const windows = resolveQualityStatsWindows("7d", new Date("2026-07-28T13:45:00.000Z"));

  it("merges aggregate rows onto their UTC day and leaves other days zero-filled", () => {
    const merged = mergeQualityStatsBuckets(buildEmptyQualityStatsBuckets(windows), [
      {
        bucket_start: new Date("2026-07-24T00:00:00.000Z"),
        turn_count: "10",
        grounded_count: "6",
        grounding_gap_count: "2",
        negative_feedback_count: "1",
        rated_count: "4",
        skill_failure_count: "3",
      },
    ]);

    const day = merged.find((bucket) => bucket.date === "2026-07-24");
    expect(day).toEqual({
      date: "2026-07-24",
      turnCount: 10,
      grounded: { count: 6, denominator: 8, rate: 0.75 },
      negativeFeedback: { count: 1, denominator: 4, rate: 0.25 },
      skillFailures: { count: 3, denominator: 10, rate: 0.3 },
    });
    expect(merged.find((bucket) => bucket.date === "2026-07-25")?.turnCount).toBe(0);
  });

  it("ignores rows outside the window rather than inventing a bucket", () => {
    const merged = mergeQualityStatsBuckets(buildEmptyQualityStatsBuckets(windows), [
      { bucket_start: new Date("2026-01-01T00:00:00.000Z"), ...emptyRow, turn_count: "99" },
    ]);

    expect(merged).toHaveLength(7);
    expect(merged.every((bucket) => bucket.turnCount === 0)).toBe(true);
  });
});

describe("toQualityStatsWindow", () => {
  const windows = resolveQualityStatsWindows("7d", new Date("2026-07-28T13:45:00.000Z"));

  it("coerces int8-as-text aggregates and derives every rate", () => {
    const window = toQualityStatsWindow(windows.current, {
      turn_count: "200",
      grounded_count: "80",
      grounding_gap_count: "20",
      negative_feedback_count: "5",
      rated_count: "50",
      skill_failure_count: "10",
    });

    expect(window).toEqual({
      from: "2026-07-22T00:00:00.000Z",
      to: "2026-07-29T00:00:00.000Z",
      turnCount: 200,
      grounded: { count: 80, denominator: 100, rate: 0.8 },
      negativeFeedback: { count: 5, denominator: 50, rate: 0.1 },
      skillFailures: { count: 10, denominator: 200, rate: 0.05 },
    });
  });

  it("reports a null rate rather than NaN when the denominator is zero", () => {
    const window = toQualityStatsWindow(windows.current, emptyRow);

    expect(window.turnCount).toBe(0);
    expect(window.grounded).toEqual({ count: 0, denominator: 0, rate: null });
    expect(window.negativeFeedback.rate).toBeNull();
    expect(window.skillFailures.rate).toBeNull();
  });

  it("treats a missing aggregate row as an empty window", () => {
    expect(toQualityStatsWindow(windows.current, undefined).turnCount).toBe(0);
  });
});

describe("sumQualityStatsRows", () => {
  it("adds every count column across rows, coercing int8-as-text", () => {
    expect(
      sumQualityStatsRows([
        {
          turn_count: "10",
          grounded_count: "6",
          grounding_gap_count: "2",
          negative_feedback_count: "1",
          rated_count: "4",
          skill_failure_count: "3",
        },
        {
          turn_count: 5,
          grounded_count: 1,
          grounding_gap_count: 1,
          negative_feedback_count: 0,
          rated_count: 2,
          skill_failure_count: 1,
        },
      ]),
    ).toEqual({
      turn_count: 15,
      grounded_count: 7,
      grounding_gap_count: 3,
      negative_feedback_count: 1,
      rated_count: 6,
      skill_failure_count: 4,
    });
  });

  it("sums no rows to zeros rather than undefined", () => {
    expect(sumQualityStatsRows([])).toEqual({
      turn_count: 0,
      grounded_count: 0,
      grounding_gap_count: 0,
      negative_feedback_count: 0,
      rated_count: 0,
      skill_failure_count: 0,
    });
  });
});

describe("summarizeQualityStatsWindow", () => {
  const windows = resolveQualityStatsWindows("7d", new Date("2026-07-28T13:45:00.000Z"));

  const row = (date: string, counts: Partial<Record<string, string>> = {}) => ({
    bucket_start: new Date(`${date}T00:00:00.000Z`),
    ...emptyRow,
    ...counts,
  });

  it("splits one span of daily rows into the current and previous windows", () => {
    // One query covers 2026-07-15 .. 2026-07-28 inclusive; each day belongs to exactly one
    // window, so the two windows partition the same rows.
    const dailyRows = [
      row("2026-07-16", { turn_count: "4", grounded_count: "3", grounding_gap_count: "1" }),
      row("2026-07-21", { turn_count: "6", grounded_count: "4", grounding_gap_count: "2" }),
      row("2026-07-22", { turn_count: "10", grounded_count: "8", grounding_gap_count: "2" }),
      row("2026-07-28", { turn_count: "5", grounded_count: "5" }),
    ];

    const current = summarizeQualityStatsWindow(windows.current, dailyRows);
    const previous = summarizeQualityStatsWindow(windows.previous, dailyRows);

    expect(current.turnCount).toBe(15);
    expect(current.grounded).toEqual({ count: 13, denominator: 15, rate: 13 / 15 });
    expect(previous.turnCount).toBe(10);
    expect(previous.grounded).toEqual({ count: 7, denominator: 10, rate: 0.7 });
  });

  it("agrees with the buckets built from the same rows, by construction", () => {
    const dailyRows = [
      row("2026-07-21", { turn_count: "99" }),
      row("2026-07-22", { turn_count: "10" }),
      row("2026-07-25", { turn_count: "7" }),
      row("2026-07-28", { turn_count: "5" }),
    ];

    const current = summarizeQualityStatsWindow(windows.current, dailyRows);
    const buckets = mergeQualityStatsBuckets(buildEmptyQualityStatsBuckets(windows), dailyRows);

    expect(buckets.reduce((total, bucket) => total + bucket.turnCount, 0)).toBe(current.turnCount);
    expect(current.turnCount).toBe(22);
  });

  it("recomputes the rate from summed counts when a metric is undefined on some days", () => {
    // Two of the three days have no rated turns at all. Averaging the daily rates would
    // divide by the wrong thing (or by zero); the window rate is 3 rated-down out of 4 rated.
    const dailyRows = [
      row("2026-07-23", { turn_count: "50" }),
      row("2026-07-24", { turn_count: "50", negative_feedback_count: "3", rated_count: "4" }),
      row("2026-07-25", { turn_count: "50" }),
    ];

    const current = summarizeQualityStatsWindow(windows.current, dailyRows);

    expect(current.negativeFeedback).toEqual({ count: 3, denominator: 4, rate: 0.75 });
    expect(current.turnCount).toBe(150);
    expect(current.skillFailures).toEqual({ count: 0, denominator: 150, rate: 0 });
  });

  it("reports an empty previous window when no day in it produced a row", () => {
    const dailyRows = [row("2026-07-22", { turn_count: "10", grounded_count: "10" })];

    const previous = summarizeQualityStatsWindow(windows.previous, dailyRows);

    expect(previous.from).toBe("2026-07-15T00:00:00.000Z");
    expect(previous.to).toBe("2026-07-22T00:00:00.000Z");
    expect(previous.turnCount).toBe(0);
    expect(previous.grounded).toEqual({ count: 0, denominator: 0, rate: null });
    expect(previous.negativeFeedback.rate).toBeNull();
    expect(previous.skillFailures.rate).toBeNull();
  });

  it("ignores rows outside both windows rather than folding them into either", () => {
    const dailyRows = [
      row("2026-01-01", { turn_count: "99" }),
      row("2026-07-22", { turn_count: "10" }),
    ];

    expect(summarizeQualityStatsWindow(windows.current, dailyRows).turnCount).toBe(10);
    expect(summarizeQualityStatsWindow(windows.previous, dailyRows).turnCount).toBe(0);
  });
});

describe("buildQualityStatsDailyQuery", () => {
  const windows = resolveQualityStatsWindows("7d", new Date("2026-07-28T13:45:00.000Z"));

  it("groups by UTC day", () => {
    const query = buildQualityStatsDailyQuery({
      workspaceId: WORKSPACE_ID,
      window: windows.span,
      tuples: TUPLES,
    });

    // The trailing conversion back to timestamptz is load-bearing: without it the driver
    // reads the truncated bare timestamp as local wall time and buckets shift a day.
    expect(query.text).toContain(
      "date_trunc('day', m.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start",
    );
    expect(query.text).toContain("GROUP BY bucket_start");
  });

  it("scopes to assistant turns in the workspace and excludes operator-test and human-authored turns", () => {
    const query = buildQualityStatsDailyQuery({
      workspaceId: WORKSPACE_ID,
      window: windows.current,
      tuples: TUPLES,
    });

    expect(query.params[0]).toBe(WORKSPACE_ID);
    expect(query.text).toContain("m.role = 'assistant'");
    expect(query.text).toContain("c.source_channel IS NULL OR c.source_channel NOT IN");
    expect(query.text).toContain("m.source IS NULL OR m.source NOT IN");
    expect(query.params).toContain("authenticated_chat");
    expect(query.params).toContain("workbench_replay");
    expect(query.params).toContain("human_agent");
    expect(query.params).toContain("human_agent_on_behalf_of_ai_agent");
  });

  it("bounds the window inclusive-from and exclusive-to", () => {
    const query = buildQualityStatsDailyQuery({
      workspaceId: WORKSPACE_ID,
      window: windows.current,
      tuples: TUPLES,
    });

    expect(query.text).toMatch(/m\.created_at >= \$\d+::timestamptz/);
    expect(query.text).toMatch(/m\.created_at < \$\d+::timestamptz/);
    expect(query.params).toContain(windows.current.from.toISOString());
    expect(query.params).toContain(windows.current.to.toISOString());
  });

  it("binds every placeholder it references, in order", () => {
    const query = buildQualityStatsDailyQuery({
      workspaceId: WORKSPACE_ID,
      window: windows.current,
      tuples: TUPLES,
      agentId: AGENT_ID,
      channel: "embed",
    });

    const referenced = [...query.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    expect(Math.max(...referenced)).toBe(query.params.length);
    expect(new Set(referenced).size).toBe(query.params.length);
    expect(query.params).toContain(AGENT_ID);
    expect(query.params).toContain("embed");
  });

  it("omits agent and channel predicates when no filter is applied", () => {
    const query = buildQualityStatsDailyQuery({
      workspaceId: WORKSPACE_ID,
      window: windows.current,
      tuples: TUPLES,
    });

    expect(query.text).not.toContain("c.agent_id =");
    expect(query.text).not.toContain("c.source_channel =");
  });

  it("counts feedback per turn with correlated EXISTS rather than a fan-out join", () => {
    const query = buildQualityStatsDailyQuery({
      workspaceId: WORKSPACE_ID,
      window: windows.current,
      tuples: TUPLES,
    });

    expect(query.text).not.toMatch(/JOIN\s+assistant_answer_feedback/);
    expect(query.text).toContain("FROM assistant_answer_feedback f");
    expect(query.text).toContain("EXISTS");
  });

  it("passes the catalog's grounded and gap tuples as arrays, not inlined names", () => {
    const query = buildQualityStatsDailyQuery({
      workspaceId: WORKSPACE_ID,
      window: windows.current,
      tuples: TUPLES,
    });

    expect(query.text).not.toContain("no_context");
    expect(query.params).toContainEqual(["retrieval.answer"]);
    expect(query.params).toContainEqual(["grounded"]);
    expect(query.params).toContainEqual(["no_context"]);
  });
});

describe("buildQualityStatsBacklogQuery", () => {
  it("counts active-triage turns with no date bound", () => {
    const query = buildQualityStatsBacklogQuery({
      workspaceId: WORKSPACE_ID,
      tuples: TUPLES,
    });

    expect(query.text).not.toContain("m.created_at >=");
    expect(query.text).not.toContain("m.created_at <");
    expect(query.text).toContain("feedback_freshness.updated_at > tr.updated_at");
    expect(query.text).toContain("THEN 'open'");
    expect(query.params).toContainEqual(["open", "acknowledged"]);
  });

  it("resolves latency from the persisted column with the audit event as a fallback", () => {
    const query = buildQualityStatsBacklogQuery({ workspaceId: WORKSPACE_ID, tuples: TUPLES });

    expect(query.text).toContain("COALESCE(m.total_latency_ms, (");
    expect(query.params).toContain(10_000);
  });

  // The fallback must be a COALESCE arm, not a join: a join probes audit_events for every
  // row in the population, including the overwhelming majority whose latency is already
  // persisted. COALESCE only evaluates the arguments it needs.
  it("reaches audit_events from inside COALESCE rather than joining it per row", () => {
    const query = buildQualityStatsBacklogQuery({ workspaceId: WORKSPACE_ID, tuples: TUPLES });

    expect(query.text).not.toMatch(/JOIN\s+LATERAL/);
    expect(query.text).toContain("FROM audit_events ae");
    expect(query.text).toContain("ORDER BY ae.created_at DESC, ae.id DESC");
  });

  it("still applies the shared turn population and echoes agent/channel filters", () => {
    const query = buildQualityStatsBacklogQuery({
      workspaceId: WORKSPACE_ID,
      tuples: TUPLES,
      agentId: AGENT_ID,
      channel: "embed",
    });

    expect(query.text).toContain("m.role = 'assistant'");
    expect(query.text).toContain("m.source IS NULL OR m.source NOT IN");
    const referenced = [...query.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    expect(Math.max(...referenced)).toBe(query.params.length);
    expect(new Set(referenced).size).toBe(query.params.length);
  });
});

describe("buildQualityResolutionBreakdownQuery", () => {
  const windows = resolveQualityStatsWindows("7d", new Date("2026-07-28T13:45:00.000Z"));

  it("counts current terminal rows by typed reason or unspecified in the closure window", () => {
    const query = buildQualityResolutionBreakdownQuery({
      workspaceId: WORKSPACE_ID,
      window: windows.current,
    });

    expect(query.text).toContain("assistant_answer_triage tr");
    expect(query.text).toContain("tr.state IN ('resolved', 'dismissed')");
    expect(query.text).toContain("feedback_freshness.updated_at > tr.updated_at");
    expect(query.text).toContain("NOT (");
    expect(query.text).toContain("COALESCE(tr.resolution_reason, 'unspecified')");
    expect(query.text).toMatch(/tr\.closed_at >= \$\d+::timestamptz/);
    expect(query.text).toMatch(/tr\.closed_at < \$\d+::timestamptz/);
    expect(query.text).toContain("GROUP BY tr.state, tr.resolution_reason");
    expect(query.params).toContain(windows.current.from.toISOString());
    expect(query.params).toContain(windows.current.to.toISOString());
  });

  it("uses the shared turn population and honors agent/channel scope", () => {
    const query = buildQualityResolutionBreakdownQuery({
      workspaceId: WORKSPACE_ID,
      window: windows.current,
      agentId: AGENT_ID,
      channel: "embed",
    });

    expect(query.text).toContain("m.role = 'assistant'");
    expect(query.text).toContain("c.source_channel IS NULL OR c.source_channel NOT IN");
    expect(query.params).toContain(AGENT_ID);
    expect(query.params).toContain("embed");
  });
});
