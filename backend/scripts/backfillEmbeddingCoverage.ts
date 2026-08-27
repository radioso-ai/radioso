import { getEnv } from "../src/app/config/env.js";
import { Database } from "../src/shared/infra/database.js";
import { DocumentProcessingJobRepository } from "../src/db/repositories/documentProcessingJobRepository.js";
import { EmbeddingCoverageReconciler } from "../src/modules/embeddingProfiles/services/embeddingCoverageReconciler.js";

/**
 * Enqueues canonical embedding coverage for every workspace that still has chunks
 * without a `chunk_embeddings` row.
 *
 * Coverage reconciliation otherwise runs only when a document is ingested, so a
 * workspace that has not ingested since canonical embeddings shipped has no active
 * vector projection. The canonical table is the one that supports more than one
 * embedding width, so changing embedding model would otherwise find no vectors.
 *
 * Enqueued jobs are drained by the document worker's own polling loop, so no
 * dispatcher is needed here; the reconciler's default no-op dispatch is correct for
 * a standalone run. The work is idempotent: jobs target chunks that are missing a
 * canonical row, so re-running enqueues nothing once coverage is complete.
 *
 * A workspace with no `workspace_embedding_profiles` row cannot be enqueued, because
 * coverage joins that table. Those are reported separately and the script exits
 * non-zero, rather than reporting a gap it silently leaves untouched.
 *
 *   pnpm exec tsx ./scripts/backfillEmbeddingCoverage.ts --dry-run
 *   pnpm exec tsx ./scripts/backfillEmbeddingCoverage.ts
 */
const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run");
  const env = getEnv();
  const database = new Database(env.DATABASE_URL, {
    applicationName: "radioso-embedding-coverage-backfill",
  });

  try {
    const jobs = new DocumentProcessingJobRepository(database.kysely);
    const gaps = await jobs.listWorkspaceCanonicalEmbeddingGaps();

    if (gaps.length === 0) {
      console.log("Canonical embedding coverage is complete; nothing to enqueue.");
      return;
    }

    const actionable = gaps.filter((gap) => gap.hasEmbeddingProfile);
    const blocked = gaps.filter((gap) => !gap.hasEmbeddingProfile);
    const totalMissing = gaps.reduce((sum, gap) => sum + gap.missingChunks, 0);
    console.log(
      `${gaps.length} workspace(s) with ${totalMissing} chunk(s) missing canonical embeddings:`,
    );
    const stuck = gaps.filter((gap) => gap.hasEmbeddingProfile && gap.failedJobs > 0);
    for (const gap of gaps) {
      const notes = [
        gap.hasEmbeddingProfile ? null : "no embedding profile",
        gap.failedJobs > 0 ? `${gap.failedJobs} failed job(s)` : null,
      ].filter(Boolean);
      const suffix = notes.length > 0 ? `   [${notes.join(", ")}]` : "";
      console.log(`  ${gap.workspaceId}  ${gap.missingChunks}${suffix}`);
    }

    if (stuck.length > 0) {
      // Enqueueing suppresses inserts on the profile-job unique key, which a job
      // that has exhausted its attempts still holds. Re-running cannot clear these;
      // the failed jobs have to be resolved or retired first.
      console.log(
        `\n${stuck.length} workspace(s) have embedding_profile jobs in a failed `
        + "state. Those hold the job key, so re-running enqueues nothing for them "
        + "until the failures are resolved:",
      );
      for (const gap of stuck) {
        console.log(`  ${gap.workspaceId}  ${gap.failedJobs} failed job(s)`);
      }
    }

    if (blocked.length > 0) {
      // Coverage enqueueing joins workspace_embedding_profiles, so these workspaces
      // would silently produce zero jobs. Choosing an embedding space for them is a
      // configuration decision, made by setting the workspace's embedding model.
      console.log(
        `\n${blocked.length} workspace(s) have no embedding profile and cannot be `
        + "backfilled until one exists. Set the embedding model for each, then re-run:",
      );
      for (const gap of blocked) {
        console.log(`  ${gap.workspaceId}  ${gap.missingChunks} chunk(s)`);
      }
    }

    // A gap the script cannot move is the reason to exit non-zero, and --dry-run is
    // the form an operator reaches for first, so the signal survives that path too.
    if (blocked.length > 0 || stuck.length > 0) {
      process.exitCode = 1;
    }

    if (dryRun) {
      console.log("\n--dry-run: no work enqueued.");
      return;
    }

    if (actionable.length === 0) {
      console.log("\nNothing to enqueue.");
      return;
    }

    // Re-embedding is deliberate rather than copying the legacy vector across: the
    // job carries chunk text and the worker embeds it with the workspace's active
    // profile, so the stored vector is guaranteed to match the space it is filed
    // under. Copying would assume the legacy column came from that same model.
    const reconciler = new EmbeddingCoverageReconciler(jobs);
    let enqueued = 0;
    let skipped = 0;
    for (const gap of actionable) {
      const outcome = await reconciler.reconcileWorkspace(gap.workspaceId);
      enqueued += outcome.enqueued;
      skipped += outcome.skipped;
      console.log(
        `  ${gap.workspaceId}  enqueued=${outcome.enqueued} skipped=${outcome.skipped}`,
      );
    }

    console.log(
      `\nEnqueued ${enqueued} job(s), skipped ${skipped}. `
      + "The document worker drains these by polling; re-run --dry-run to check progress.",
    );
  } finally {
    await database.close();
  }
};

main()
  // Preserve the exit code set for workspaces that could not be backfilled, so a
  // partial run is visible to whatever is driving the script.
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
