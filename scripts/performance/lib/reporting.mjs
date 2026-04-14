import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ARTIFACT_DIR = path.resolve(process.cwd(), ".context/performance-runs");

export const parseCliArgs = (argv) => {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
};

export const resolveArtifactPath = async ({ profileId, outputPath, now = new Date() }) => {
  if (outputPath) {
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    return path.resolve(outputPath);
  }

  await mkdir(DEFAULT_ARTIFACT_DIR, { recursive: true });
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(DEFAULT_ARTIFACT_DIR, `${timestamp}-${profileId}.json`);
};

export const writeArtifact = async ({ artifact, outputPath }) => {
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return outputPath;
};

export const formatRunSummary = (artifact) => {
  const lines = [
    `Profile: ${artifact.profileId} (${artifact.environmentClass})`,
    `Status: ${artifact.status}`,
    `Latency: p50=${Math.round(artifact.summary.latencyMs.p50)}ms p95=${Math.round(artifact.summary.latencyMs.p95)}ms p99=${Math.round(artifact.summary.latencyMs.p99)}ms`,
    `Throughput: ${artifact.summary.throughputRps.toFixed(2)} rps`,
    `Error rate: ${(artifact.summary.errorRate * 100).toFixed(2)}%`,
    `Verdict: ${artifact.summary.verdict}`,
  ];

  if (artifact.summary.queueSummary) {
    lines.push(
      `Queue: queued_peak=${artifact.summary.queueSummary.queuedJobCountPeak} processing_peak=${artifact.summary.queueSummary.processingJobCountPeak} oldest_age_peak=${artifact.summary.queueSummary.oldestQueuedAgeMsPeak ?? "n/a"}ms drain=${artifact.summary.queueSummary.drainTimeMs ?? "n/a"}ms`,
    );
  }

  if (artifact.warnings?.length) {
    lines.push(`Warnings: ${artifact.warnings.join(" | ")}`);
  }

  return lines.join("\n");
};

export const formatComparisonSummary = (comparison) => {
  const lines = [`Overall verdict: ${comparison.overallVerdict}`];

  for (const metric of comparison.metricDiffs ?? []) {
    lines.push(
      `${metric.metricName}: baseline=${metric.baseline ?? "n/a"} candidate=${metric.candidate ?? "n/a"} verdict=${metric.verdict}`,
    );
  }

  if (comparison.inconclusiveReasons?.length) {
    lines.push(`Inconclusive reasons: ${comparison.inconclusiveReasons.join(" | ")}`);
  }

  return lines.join("\n");
};
