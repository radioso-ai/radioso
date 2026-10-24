import { parseWorkspaceStorageSweepArgs, runWorkspaceStorageSweepCommand } from "./app/cli/workspaceStorageSweepCommand.js";
import { createDefaultDocumentStorage } from "./app/composition/defaultComposition.js";
import { getEnv } from "./app/config/env.js";
import { AuditEventRepository } from "./db/repositories/auditEventRepository.js";
import { BackgroundJobRepository } from "./db/repositories/backgroundJobRepository.js";
import { DocumentStorageOwnerRepository } from "./db/repositories/documentStorageOwnerRepository.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { DefaultBackgroundJobQueue, NoopBackgroundJobWake } from "./shared/background-jobs/index.js";
import { Database } from "./shared/infra/database.js";
import { createLogger } from "./shared/observability/logger.js";

/**
 * Finds stored files whose workspace this database no longer has, in the store
 * `DOCUMENT_STORAGE_DRIVER` / `DOCUMENT_STORAGE_BUCKET` select, and with `--apply` queues one purge
 * per orphaned workspace for the worker. Without `--apply` it reads and reports counts, and changes
 * nothing. It runs with the worker's environment and identity: the database, and a storage identity
 * that may list objects.
 *
 *   node ./dist/src/workspaceStorageSweep.js                                # dry run: note the orphan count
 *   node ./dist/src/workspaceStorageSweep.js --apply --expect-orphans <n>   # queue the purges it reports
 *   node ./dist/src/workspaceStorageSweep.js --workspace <id>               # one workspace, dry run
 *   node ./dist/src/workspaceStorageSweep.js --workspace <id> --apply       # re-queue its purge
 *
 * From a checkout, `pnpm --dir backend run storage:sweep-orphans` takes the same arguments. A store
 * shared with another deployment reports that deployment's workspaces as orphaned: read
 * docs-portal/content/operators/self-hosting-operations.mdx before `--apply`. Queued purges wait for
 * the worker's poll loop or the scheduled recovery sweep.
 */

/** Ends a one-off run (a Cloud Run job) even if a client library left a handle open after the work. */
const EXIT_GRACE_MS = 10_000;

const main = async (): Promise<number> => {
  const command = parseWorkspaceStorageSweepArgs(process.argv.slice(2));
  loadEnvFileIfPresent();
  const env = getEnv();
  const database = new Database(env.DATABASE_URL, { applicationName: "radioso-workspace-storage-sweep", poolMax: 2 });
  const auditEvents = new AuditEventRepository(database.kysely);
  try {
    const { exitCode } = await runWorkspaceStorageSweepCommand(command, {
      storage: createDefaultDocumentStorage(env),
      owners: new DocumentStorageOwnerRepository(database.kysely),
      queue: new DefaultBackgroundJobQueue({
        writer: new BackgroundJobRepository(database.kysely),
        wake: new NoopBackgroundJobWake(),
        logger: createLogger(),
      }),
      audit: { record: async (event) => { await auditEvents.create(event); } },
      print: (line) => process.stdout.write(`${line}\n`),
    });
    return exitCode;
  } finally {
    await database.close();
  }
};

const finish = (exitCode: number): void => {
  process.exitCode = exitCode;
  // Unref'd, so a process with nothing left to do exits at once and its output drains first.
  setTimeout(() => process.exit(exitCode), EXIT_GRACE_MS).unref();
};

main().then(finish, (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Workspace storage sweep failed"}\n`);
  finish(1);
});
