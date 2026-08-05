/**
 * DEVELOPMENT TOOL. Not part of any production build, not invoked at runtime,
 * not compiled into `dist/` (tsconfig includes only `src/` and `tests/`).
 * Lives under `backend/scripts/dev/` to keep it visibly separate from
 * build-time codegen scripts in `backend/scripts/`.
 *
 * Backfill (spec 956 T034): enqueues facet extraction jobs for a workspace's
 * eligible visitor questions that predate the feature. The census can only
 * cluster a question once `message_facets` has a current-prompt-version facet
 * for it, and nothing enqueues that retroactively for messages sent before
 * facet extraction started running on every turn
 * (`src/modules/chat/services/chatSessionPreparer.ts`).
 *
 * Reuses the exact eligibility rule the census itself reads
 * (`PostgresAudiencePulseHistorySource.listEligibleQuestionIds`) rather than
 * restating it, and the same `FacetExtractionJobRepository.enqueue` the live
 * turn path uses -- idempotent on the `facet_extraction_jobs.message_id`
 * unique constraint (`ON CONFLICT DO NOTHING`), so re-running is always safe.
 * `enqueue`'s `created` flag is what separates "newly enqueued" from "already
 * present" in the report. A dry run reads the same job table without writing,
 * so it reports the identical split with zero side effects.
 *
 * Processes ids in small batches, with a delay between batches and a bounded
 * connection pool, deliberately slower than a single bulk insert would be:
 * `facet_extraction_jobs` and `document_processing_jobs` share this database,
 * and a burst of thousands of writes must not compete with document
 * processing for connections or lock time.
 *
 * Usage:
 *   cd backend && pnpm exec tsx scripts/dev/backfillFacetExtractionJobs.ts \
 *     --workspace-id <uuid> \
 *     [--start <ISO date>] [--end <ISO date>] \
 *     [--batch-size 200] [--concurrency 5] [--delay-ms 250] \
 *     [--dry-run]
 *
 * Env vars required:
 *   DATABASE_URL   Postgres connection string (or pass --database-url)
 *
 * --start/--end default to the trailing 365 days ending now, matching the
 * census's own analysis window (spec 956 "Assumptions And Dependencies").
 */

import { Database } from "../../src/shared/infra/database.js";
import { FacetExtractionJobRepository } from "../../src/db/repositories/facetExtractionJobRepository.js";
import { MessageFacetRepository } from "../../src/db/repositories/messageFacetRepository.js";
import { PostgresAudiencePulseHistorySource } from "../../src/modules/chat/audiencePulseHistorySource.js";
import { FACET_EXTRACTION_PROMPT_VERSION } from "../../src/modules/facets/composition.js";

interface CliArgs {
  workspaceId: string;
  start: Date;
  end: Date;
  batchSize: number;
  concurrency: number;
  delayMs: number;
  dryRun: boolean;
  databaseUrl?: string;
}

const DEFAULT_WINDOW_DAYS = 365;

const parsePositiveInt = (raw: string | undefined, flag: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    process.stderr.write(`${flag} expects a positive integer, got: ${String(raw)}\n`);
    process.exit(1);
  }
  return value;
};

const parseDate = (raw: string | undefined, flag: string): Date => {
  const value = raw ? new Date(raw) : undefined;
  if (!value || Number.isNaN(value.getTime())) {
    process.stderr.write(`${flag} expects an ISO date, got: ${String(raw)}\n`);
    process.exit(1);
  }
  return value;
};

const parseArgs = (argv: string[]): CliArgs => {
  const now = new Date();
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace-id") args.workspaceId = argv[++i];
    else if (arg === "--start") args.start = parseDate(argv[++i], "--start");
    else if (arg === "--end") args.end = parseDate(argv[++i], "--end");
    else if (arg === "--batch-size") args.batchSize = parsePositiveInt(argv[++i], "--batch-size");
    else if (arg === "--concurrency") args.concurrency = parsePositiveInt(argv[++i], "--concurrency");
    else if (arg === "--delay-ms") args.delayMs = parsePositiveInt(argv[++i], "--delay-ms");
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--database-url") args.databaseUrl = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: pnpm exec tsx scripts/dev/backfillFacetExtractionJobs.ts --workspace-id <uuid> "
        + "[--start ISO] [--end ISO] [--batch-size 200] [--concurrency 5] [--delay-ms 250] [--dry-run]\n",
      );
      process.exit(0);
    }
  }
  if (!args.workspaceId) {
    process.stderr.write("Missing --workspace-id\n");
    process.exit(1);
  }
  const end = args.end ?? now;
  const start = args.start ?? new Date(end.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    workspaceId: args.workspaceId,
    start,
    end,
    batchSize: args.batchSize ?? 200,
    concurrency: args.concurrency ?? 5,
    delayMs: args.delayMs ?? 250,
    dryRun: args.dryRun ?? false,
    databaseUrl: args.databaseUrl,
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
};

/** Bounded-concurrency worker pool, mirroring `recordFacetQualityFixture.ts`. */
const mapWithConcurrency = async <Input, Output>(
  items: readonly Input[],
  limit: number,
  worker: (item: Input) => Promise<Output>,
): Promise<Output[]> => {
  const results = new Array<Output>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (or pass --database-url)");
  }

  // Bounded pool: this script must never out-compete document processing or the
  // facet extraction worker for connections against the same database.
  const database = new Database(databaseUrl, { applicationName: "audience-pulse-facet-backfill", poolMax: 4 });

  try {
    const historySource = new PostgresAudiencePulseHistorySource(database.kysely);
    const facetExtractionJobs = new FacetExtractionJobRepository(database.kysely);
    const messageFacets = new MessageFacetRepository(database.kysely);

    const eligibleIds = await historySource.listEligibleQuestionIds({
      workspaceId: args.workspaceId,
      analysisStart: args.start,
      analysisEnd: args.end,
    });

    process.stdout.write(
      `Workspace ${args.workspaceId}: ${eligibleIds.length} eligible question(s) between `
      + `${args.start.toISOString()} and ${args.end.toISOString()}\n`,
    );

    if (eligibleIds.length === 0) {
      process.stdout.write("Nothing to enqueue.\n");
      return;
    }

    const embeddingProfile = await database.kysely
      .selectFrom("workspace_embedding_profiles")
      .select("active_embedding_space_id")
      .where("workspace_id", "=", args.workspaceId)
      .executeTakeFirst();
    if (!embeddingProfile) {
      throw new Error(`Workspace ${args.workspaceId} has no active embedding profile`);
    }

    const missingCurrentFacetIds = await messageFacets.listMessageIdsMissingCurrentFacet({
      workspaceId: args.workspaceId,
      messageIds: eligibleIds,
      promptVersion: FACET_EXTRACTION_PROMPT_VERSION,
      embeddingProfileId: embeddingProfile.active_embedding_space_id,
    });
    const batches = chunk(missingCurrentFacetIds, args.batchSize);
    let newlyEnqueued = 0;
    let alreadyPresent = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex]!;

      if (args.dryRun) {
        // Read-only equivalent of the version-aware enqueue below.
        const existing = await database.kysely
          .selectFrom("facet_extraction_jobs")
          .select("message_id")
          .where("message_id", "in", batch)
          .execute();
        alreadyPresent += existing.length;
        newlyEnqueued += batch.length - existing.length;
      } else {
        const results = await mapWithConcurrency(batch, args.concurrency, (messageId) =>
          facetExtractionJobs.enqueue({ messageId, workspaceId: args.workspaceId, restartTerminal: true }));
        for (const result of results) {
          if (result.created) {
            newlyEnqueued += 1;
          } else {
            alreadyPresent += 1;
          }
        }
      }

      process.stdout.write(
        `  batch ${batchIndex + 1}/${batches.length} (${batch.length} id(s)) done -- `
        + `running totals: newly enqueued ${newlyEnqueued}, already present ${alreadyPresent}\n`,
      );

      if (batchIndex < batches.length - 1 && args.delayMs > 0) {
        await sleep(args.delayMs);
      }
    }

    process.stdout.write(
      `${args.dryRun ? "[dry run] " : ""}Eligible: ${eligibleIds.length}  `
      + `Missing current facet: ${missingCurrentFacetIds.length}  `
      + `Newly enqueued: ${newlyEnqueued}  Reused/restarted: ${alreadyPresent}\n`,
    );
  } finally {
    await database.pool.end();
  }
};

main().catch((err) => {
  process.stderr.write(`backfill failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
