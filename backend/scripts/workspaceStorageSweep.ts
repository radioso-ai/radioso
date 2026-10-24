import { createDefaultDocumentStorage } from "../src/app/composition/defaultComposition.js";
import { getEnv } from "../src/app/config/env.js";
import { BackgroundJobRepository } from "../src/db/repositories/backgroundJobRepository.js";
import { DocumentStorageOwnerRepository } from "../src/db/repositories/documentStorageOwnerRepository.js";
import { loadEnvFileIfPresent } from "../src/runtime/loadEnv.js";
import { DefaultBackgroundJobQueue, NoopBackgroundJobWake } from "../src/shared/background-jobs/index.js";
import { Database } from "../src/shared/infra/database.js";
import { createLogger } from "../src/shared/observability/logger.js";
import { parseWorkspaceStorageSweepArgs, runWorkspaceStorageSweepCommand } from "./workspaceStorageSweepCommand.js";

/**
 * Finds stored files whose workspace this database no longer has, against the store
 * `DOCUMENT_STORAGE_DRIVER` / `DOCUMENT_STORAGE_BUCKET` select, and with `--apply` queues their
 * removal for the worker. Without `--apply` it reads and reports counts, and changes nothing.
 *
 *   pnpm --dir backend run storage:sweep-orphans                          # dry run of the sweep
 *   pnpm --dir backend run storage:sweep-orphans --apply                  # queue the sweep
 *   pnpm --dir backend run storage:sweep-orphans --workspace <id>         # one workspace, dry run
 *   pnpm --dir backend run storage:sweep-orphans --workspace <id> --apply # re-queue its purge
 *
 * A store this database shares with another deployment reports that deployment's workspaces as
 * orphaned. Run the dry run first and read docs-portal/content/operators/self-hosting-operations.mdx
 * before `--apply`. Queued jobs wait for the worker's poll loop or the scheduled recovery sweep.
 */
const main = async (): Promise<void> => {
  const command = parseWorkspaceStorageSweepArgs(process.argv.slice(2));
  loadEnvFileIfPresent();
  const env = getEnv();
  const database = new Database(env.DATABASE_URL, { applicationName: "radioso-workspace-storage-sweep", poolMax: 2 });
  try {
    const { exitCode } = await runWorkspaceStorageSweepCommand(command, {
      storage: createDefaultDocumentStorage(env),
      owners: new DocumentStorageOwnerRepository(database.kysely),
      queue: new DefaultBackgroundJobQueue({
        writer: new BackgroundJobRepository(database.kysely),
        wake: new NoopBackgroundJobWake(),
        logger: createLogger(),
      }),
      print: (line) => process.stdout.write(`${line}\n`),
    });
    process.exitCode = exitCode;
  } finally {
    await database.close();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Workspace storage sweep failed"}\n`);
  process.exitCode = 1;
});
