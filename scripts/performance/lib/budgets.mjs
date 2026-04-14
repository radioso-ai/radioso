import { readFile } from "node:fs/promises";

const METRIC_ALIASES = {
  "latency.p50": (summary) => summary?.latencyMs?.p50,
  "latency.p95": (summary) => summary?.latencyMs?.p95,
  "latency.p99": (summary) => summary?.latencyMs?.p99,
  throughputRps: (summary) => summary?.throughputRps,
  errorRate: (summary) => summary?.errorRate,
  "queue.queuedJobCountPeak": (summary) => summary?.queueSummary?.queuedJobCountPeak,
  "queue.processingJobCountPeak": (summary) => summary?.queueSummary?.processingJobCountPeak,
  "queue.oldestQueuedAgeMsPeak": (summary) => summary?.queueSummary?.oldestQueuedAgeMsPeak,
  "queue.drainTimeMs": (summary) => summary?.queueSummary?.drainTimeMs,
};

const getMetricValue = (summary, metric) => {
  const resolver = METRIC_ALIASES[metric];
  return resolver ? resolver(summary) : undefined;
};

const asNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const compareWithBudget = (budget, baselineValue, candidateValue) => {
  if (budget.type === "tolerance_band") {
    if (baselineValue === 0) {
      return candidateValue === 0 ? "within_tolerance" : "regression";
    }
    const deltaRatio = Math.abs(candidateValue - baselineValue) / Math.abs(baselineValue);
    if (deltaRatio <= budget.threshold) {
      return "within_tolerance";
    }
    return candidateValue > baselineValue ? "regression" : "improvement";
  }

  if (budget.type === "max") {
    if (candidateValue > budget.threshold && candidateValue >= baselineValue) {
      return "regression";
    }
    if (candidateValue < baselineValue) {
      return "improvement";
    }
    return "within_tolerance";
  }

  if (budget.type === "min") {
    if (candidateValue < budget.threshold && candidateValue <= baselineValue) {
      return "regression";
    }
    if (candidateValue > baselineValue) {
      return "improvement";
    }
    return "within_tolerance";
  }

  if (budget.type === "range") {
    const [min, max] = budget.threshold;
    if (candidateValue < min || candidateValue > max) {
      return "regression";
    }
    return candidateValue === baselineValue ? "within_tolerance" : "improvement";
  }

  return "inconclusive";
};

export const summarizeResultForComparison = (summary) => ({
  latencyMs: summary.latencyMs,
  throughputRps: summary.throughputRps,
  errorRate: summary.errorRate,
  queueSummary: summary.queueSummary ?? null,
});

export const evaluateBudgets = ({ budgets, result }) => {
  const metricVerdicts = [];
  const reasons = [];
  let overallVerdict = "pass";

  for (const budget of budgets) {
    const value = asNumber(getMetricValue(result, budget.metric));
    if (value === undefined) {
      metricVerdicts.push({ metric: budget.metric, verdict: "inconclusive", reason: "Missing required metric." });
      reasons.push(`Missing required metric: ${budget.metric}`);
      overallVerdict = "inconclusive";
      continue;
    }

    let verdict = "pass";
    if (budget.type === "max" && value > budget.threshold) {
      verdict = budget.severity === "fail" ? "fail" : "warn";
    } else if (budget.type === "min" && value < budget.threshold) {
      verdict = budget.severity === "fail" ? "fail" : "warn";
    } else if (budget.type === "range" && (value < budget.threshold[0] || value > budget.threshold[1])) {
      verdict = budget.severity === "fail" ? "fail" : "warn";
    }

    if (verdict === "fail") {
      overallVerdict = "fail";
    } else if (verdict === "warn" && overallVerdict === "pass") {
      overallVerdict = "warn";
    }

    metricVerdicts.push({ metric: budget.metric, verdict, actual: value, threshold: budget.threshold });
  }

  return {
    overallVerdict,
    metricVerdicts,
    reasons,
  };
};

export const compareResults = ({ baseline, candidate, budgets }) => {
  const metricDiffs = [];
  const regressions = [];
  const improvements = [];
  const inconclusiveReasons = [];

  for (const budget of budgets) {
    const baselineValue = asNumber(getMetricValue(baseline, budget.metric));
    const candidateValue = asNumber(getMetricValue(candidate, budget.metric));

    if (baselineValue === undefined || candidateValue === undefined) {
      inconclusiveReasons.push(`Missing metric for comparison: ${budget.metric}`);
      metricDiffs.push({
        metricName: budget.metric,
        baseline: baselineValue ?? null,
        candidate: candidateValue ?? null,
        unit: budget.unit,
        deltaPct: null,
        verdict: "inconclusive",
      });
      continue;
    }

    const deltaPct = baselineValue === 0 ? null : ((candidateValue - baselineValue) / baselineValue) * 100;
    const verdict = compareWithBudget(budget, baselineValue, candidateValue);
    metricDiffs.push({
      metricName: budget.metric,
      baseline: baselineValue,
      candidate: candidateValue,
      unit: budget.unit,
      deltaPct,
      verdict,
    });

    if (verdict === "regression") {
      regressions.push(budget.metric);
    } else if (verdict === "improvement") {
      improvements.push(budget.metric);
    }
  }

  const overallVerdict = regressions.length > 0
    ? "regression"
    : inconclusiveReasons.length > 0
      ? "inconclusive"
      : improvements.length > 0
        ? "improvement"
        : "within_tolerance";

  return {
    overallVerdict,
    metricDiffs,
    regressions,
    improvements,
    inconclusiveReasons,
  };
};

export const buildBaselineComparisonReport = ({ baselineArtifact, candidateArtifact, budgets }) => {
  if (baselineArtifact.profileId !== candidateArtifact.profileId) {
    return {
      overallVerdict: "inconclusive",
      metricDiffs: [],
      regressions: [],
      improvements: [],
      inconclusiveReasons: ["Baseline profile does not match candidate profile."],
    };
  }

  if (baselineArtifact.environmentClass !== candidateArtifact.environmentClass) {
    return {
      overallVerdict: "inconclusive",
      metricDiffs: [],
      regressions: [],
      improvements: [],
      inconclusiveReasons: ["Baseline environment class does not match candidate environment class."],
    };
  }

  return compareResults({
    baseline: summarizeResultForComparison(baselineArtifact.summary),
    candidate: summarizeResultForComparison(candidateArtifact.summary),
    budgets,
  });
};

export const loadResultArtifact = async (pathOrUrl, options = {}) => {
  const reader = options.readFile ?? readFile;
  const raw = await reader(pathOrUrl, "utf8");
  return JSON.parse(raw);
};
