import { getEnv } from "../src/app/config/env.js";
import { Database } from "../src/shared/infra/database.js";
import { DocumentProcessingJobRepository } from "../src/db/repositories/documentProcessingJobRepository.js";
import { EmbeddingCoverageReconciler } from "../src/modules/embeddingProfiles/services/embeddingCoverageReconciler.js";

/**
 * Enqueues canonical embedding coverage for every workspace that still has chunks
 * without a `chunk_embeddings` row.
 *
 * Coverage reconciliation otherwise runs only when a document is ingested, so a
 * workspace that has not ingested since canonical embeddings shipped keeps its
 * chunks in the legacy `chunks.embedding` column only. Retrieval still answers from
 * the legacy index, but the canonical table — the one that supports more than one
 * embedding width — stays empty, so changing embedding model would find no vectors.
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
    for (const gap of gaps) {
      const suffix = gap.hasEmbeddingProfile ? "" : "   [no embedding profile]";
      console.log(`  ${gap.workspaceId}  ${gap.missingChunks}${suffix}`);
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

    if (dryRun) {
      console.log("\n--dry-run: no work enqueued.");
      return;
    }

    if (actionable.length === 0) {
      console.log("\nNothing to enqueue.");
      process.exitCode = blocked.length > 0 ? 1 : 0;
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
    if (blocked.length > 0) {
      process.exitCode = 1;
    }
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
