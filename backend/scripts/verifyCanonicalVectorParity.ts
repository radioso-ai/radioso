import { pathToFileURL } from "node:url";

import { getEnv } from "../src/app/config/env.js";
import { Database } from "../src/shared/infra/database.js";
import { DocumentProcessingJobRepository } from "../src/db/repositories/documentProcessingJobRepository.js";
import {
  evaluateParity,
  formatRatio,
  minimumRequiredProbes,
  summarizeParity,
  type ParitySummary,
  type ParityThresholds,
} from "./canonicalVectorParity.js";
import {
  measureWorkspaceParity,
  openExactSearchDatabase,
  resolveParityWorkspaceSelection,
  sampleProbeVectors,
  type WorkspaceParityMeasurement,
} from "./canonicalVectorParityRunner.js";

/**
 * Gate for retiring `chunks.embedding` (issue #1063, step 2).
 *
 * Every chunk's vector is stored twice — in `chunks.embedding` and in
 * `chunk_embeddings` — and every retrieval turn searches both, keeping whatever the
 * merge produces. Removing the legacy leg is only safe once the canonical leg returns
 * what that merge returned, so this runs the same probes through each leg and reports
 * what canonical alone would have lost.
 *
 *   pnpm exec tsx ./scripts/verifyCanonicalVectorParity.ts
 *   pnpm exec tsx ./scripts/verifyCanonicalVectorParity.ts --workspace <id> --probes 200
 *   pnpm exec tsx ./scripts/verifyCanonicalVectorParity.ts --index-recall
 *
 * Exits non-zero when a workspace fails a threshold, when a workspace still has a
 * canonical coverage gap — parity measured over a partially projected table describes
 * the rows that happen to be there, not the workspace, so run
 * `backfillEmbeddingCoverage.ts` first — or when an eligible workspace has no active
 * cosine embedding space that can be measured. A database with no eligible chunks is
 * explicitly zero-risk.
 */

const DEFAULT_PROBES = 100;
const DEFAULT_TOP_K = 20;
const DEFAULT_THRESHOLDS: ParityThresholds = {
  minMeanRecall: 0.99,
  minWorstProbeRecall: 0.9,
  minProbes: 30,
};

interface WorkspaceReport {
  readonly workspaceId: string;
  readonly model: string | null;
  readonly dimensions: number | null;
  readonly probes: number;
  readonly coveredChunks: number;
  readonly eligibleChunks: number;
  readonly legacy: ParitySummary;
  readonly indexRecall: ParitySummary | null;
  readonly failures: readonly string[];
}

const parseArgs = (argv: readonly string[]) => {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const positiveInteger = (flag: string, fallback: number): number => {
    const raw = value(flag);
    if (raw === undefined) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${flag} expects a positive integer, received "${raw}"`);
    }
    return parsed;
  };
  return {
    workspaceIds: argv.reduce<string[]>((ids, arg, index) => {
      const next = argv[index + 1];
      if (arg === "--workspace" && next) {
        ids.push(next);
      }
      return ids;
    }, []),
    probes: positiveInteger("--probes", DEFAULT_PROBES),
    topK: positiveInteger("--top-k", DEFAULT_TOP_K),
    // Probe selection is a stable hash of the chunk id, so a run is reproducible and
    // two runs of the same seed compare the same neighbourhoods.
    seed: value("--seed") ?? "canonical-parity",
    measureIndexRecall: argv.includes("--index-recall"),
    json: argv.includes("--json"),
  };
};

const describeSummary = (label: string, summary: ParitySummary): string =>
  `  ${label}: mean recall ${formatRatio(summary.meanRecall)}, `
  + `worst probe ${formatRatio(summary.worstProbeRecall)}, `
  + `top-1 agreement ${formatRatio(summary.topMatchRate)}, `
  + `${summary.distinctMissingChunks} distinct chunk(s) missed, `
  + `${summary.probesWithEmptyReference} probe(s) with an empty reference, `
  + `max score delta ${summary.maxScoreDelta.toFixed(4)}`;

const printReport = (report: WorkspaceReport): void => {
  if (report.eligibleChunks === 0) {
    console.log(`\n${report.workspaceId}  PASS: 0 eligible chunks; nothing can be lost`);
    return;
  }
  console.log(
    `\n${report.workspaceId}  ${report.model} @ ${report.dimensions}d  `
    + `${report.probes} probe(s), `
    + `${report.coveredChunks}/${report.eligibleChunks} chunk(s) covered`,
  );
  console.log(describeSummary("legacy -> canonical", report.legacy));
  if (report.indexRecall) {
    console.log(describeSummary("exact  -> indexed  ", report.indexRecall));
  }
  for (const failure of report.failures) {
    console.log(`  FAIL: ${failure}`);
  }
};

const collectFailures = (input: {
  measurement: WorkspaceParityMeasurement;
  missingChunks: number;
  coveredChunks: number;
  eligibleChunks: number;
}): string[] => [
  ...evaluateParity(input.measurement.legacy.summary, {
    ...DEFAULT_THRESHOLDS,
    minProbes: minimumRequiredProbes(
      DEFAULT_THRESHOLDS.minProbes,
      input.eligibleChunks,
    ),
  }).failures,
  ...(input.measurement.indexRecall
    ? evaluateParity(input.measurement.indexRecall.summary, {
      ...DEFAULT_THRESHOLDS,
      minProbes: minimumRequiredProbes(
        DEFAULT_THRESHOLDS.minProbes,
        input.eligibleChunks,
      ),
    })
      .failures.map((failure) => `index recall: ${failure}`)
    : []),
  ...(input.missingChunks > 0
    ? [`${input.missingChunks} chunk(s) have no canonical embedding `
      + `(${input.coveredChunks}/${input.eligibleChunks} covered)`]
    : []),
];

export const formatParityGateSuccess = (
  reports: readonly { readonly eligibleChunks?: number }[],
  json: boolean,
): string => {
  if (json) {
    return JSON.stringify(reports, null, 2);
  }
  if (reports.length === 0) {
    return "Parity gate passed: no workspace has eligible chunks, so there is nothing "
      + "for legacy removal to lose.";
  }
  const measured = reports.filter((report) => (report.eligibleChunks ?? 1) > 0).length;
  const zeroRisk = reports.length - measured;
  if (measured === 0) {
    return `All ${reports.length} workspace(s) passed. Every workspace had zero eligible `
      + "chunks, so there was nothing for legacy removal to lose.";
  }
  return `All ${reports.length} workspace(s) passed: no legacy results were lost and `
    + "every compared top result matched for the sampled non-empty references"
    + (zeroRisk > 0 ? `; ${zeroRisk} workspace(s) had zero eligible chunks` : "")
    + ".";
};

export const formatParityTargetResolutionFailure = (selection: {
  readonly unresolvedWorkspaceIds: readonly string[];
  readonly missingActiveSpaceWorkspaceIds: readonly string[];
}): string => [
  ...(selection.unresolvedWorkspaceIds.length > 0
    ? ["Requested workspace id(s) could not be resolved: "
      + selection.unresolvedWorkspaceIds.join(", ")]
    : []),
  ...(selection.missingActiveSpaceWorkspaceIds.length > 0
    ? ["Eligible workspace(s) have no resolvable active cosine embedding space: "
      + selection.missingActiveSpaceWorkspaceIds.join(", ")]
    : []),
].join("\n");

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const env = getEnv();
  const database = new Database(env.DATABASE_URL, {
    applicationName: "radioso-canonical-parity",
  });
  const exactDatabase = args.measureIndexRecall
    ? openExactSearchDatabase(env.DATABASE_URL)
    : null;
  if (args.measureIndexRecall && !exactDatabase) {
    await database.close();
    console.error(
      "--index-recall needs a URL-form DATABASE_URL; it disables index scans through "
      + "the connection's options parameter.",
    );
    process.exit(1);
  }

  try {
    const jobs = new DocumentProcessingJobRepository(database.kysely);
    const selection = await resolveParityWorkspaceSelection(database, args.workspaceIds);
    const resolutionFailure = formatParityTargetResolutionFailure(selection);
    if (resolutionFailure) {
      console.error(resolutionFailure);
      process.exitCode = 1;
      return;
    }

    const emptySummary = summarizeParity([]);
    const reports: WorkspaceReport[] = selection.zeroRiskWorkspaceIds.map(
      (workspaceId) => ({
        workspaceId,
        model: null,
        dimensions: null,
        probes: 0,
        coveredChunks: 0,
        eligibleChunks: 0,
        legacy: emptySummary,
        indexRecall: null,
        failures: [],
      }),
    );
    for (const target of selection.targets) {
      const [coverage, probeVectors] = await Promise.all([
        jobs.getWorkspaceCanonicalEmbeddingCoverage(target.workspaceId),
        sampleProbeVectors(database, target, args.probes, args.seed),
      ]);
      const measurement = await measureWorkspaceParity({
        target,
        probeVectors,
        topK: args.topK,
        database,
        exactDatabase,
      });

      const report: WorkspaceReport = {
        workspaceId: target.workspaceId,
        model: target.model,
        dimensions: target.space.dimensions,
        probes: measurement.probes,
        coveredChunks: coverage.coveredChunks,
        eligibleChunks: coverage.eligibleChunks,
        legacy: measurement.legacy.summary,
        indexRecall: measurement.indexRecall?.summary ?? null,
        failures: collectFailures({
          measurement,
          missingChunks: coverage.missingChunks,
          coveredChunks: coverage.coveredChunks,
          eligibleChunks: coverage.eligibleChunks,
        }),
      };
      reports.push(report);
      if (!args.json) {
        printReport(report);
      }
    }

    const failed = reports.filter((report) => report.failures.length > 0);
    if (failed.length > 0) {
      console.error(
        `\n${failed.length} of ${reports.length} workspace(s) failed the parity gate. `
        + "The legacy leg is still carrying results canonical does not return; do not "
        + "remove it yet.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(formatParityGateSuccess(reports, args.json));
  } finally {
    await database.close();
    await exactDatabase?.close();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    // Preserve the exit code set for a failed gate, so whatever is driving the script
    // sees the failure rather than a clean run that printed warnings.
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
