import {
  isCanonicalWorkspaceId,
  orphanedWorkspaceStorageSweepRequest,
  reportOrphanedWorkspaceStorage,
  workspaceStoragePurgeRequest,
  type OrphanedWorkspaceStorageReport,
} from "../../modules/documents/composition.js";
import type {
  DocumentStorageInventoryPort,
  DocumentStorageOwnersPort,
} from "../../modules/documents/contracts/index.js";
import type { BackgroundJobQueue } from "../../shared/background-jobs/index.js";

/** What one run of the script does. Every form is a dry run unless `apply` is set. */
type WorkspaceStorageSweepCommand =
  | { kind: "sweep"; apply: boolean }
  | { kind: "workspace"; workspaceId: string; apply: boolean };

const USAGE = "Usage: workspaceStorageSweep [--apply] | --workspace <workspace id> [--apply]";

export const parseWorkspaceStorageSweepArgs = (argv: readonly string[]): WorkspaceStorageSweepCommand => {
  let apply = false;
  let workspaceId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--workspace") {
      const value = argv[index + 1];
      if (value === undefined || !isCanonicalWorkspaceId(value)) {
        throw new Error(`--workspace needs a workspace id as a lowercase UUID. ${USAGE}`);
      }
      workspaceId = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument ${argument}. ${USAGE}`);
    }
  }
  return workspaceId === null ? { kind: "sweep", apply } : { kind: "workspace", workspaceId, apply };
};

interface WorkspaceStorageSweepDependencies {
  storage: DocumentStorageInventoryPort;
  owners: DocumentStorageOwnersPort;
  queue: Pick<BackgroundJobQueue, "enqueue">;
  print: (line: string) => void;
  now?: () => Date;
}

const OWNERSHIP_LINES: Record<OrphanedWorkspaceStorageReport["ownership"], string> = {
  verified: "verified: the store holds files of this database's workspaces",
  no_uploaded_files: "skipped: this database records no uploaded file to check the store against",
  store_mismatch: "failed: the store holds none of this database's files",
};

const printReport = (report: OrphanedWorkspaceStorageReport, print: (line: string) => void): void => {
  print(`Document storage check: ${OWNERSHIP_LINES[report.ownership]}`);
  print(`Workspace prefixes scanned: ${report.scannedPrefixCount}`);
  print(`Orphaned workspaces: ${report.orphanedWorkspaceCount} (${report.orphanedObjectCount} objects)`);
  print(`Kept, workspace exists in this database: ${report.liveWorkspaceCount}`);
  print(`Kept, an object written in the last 24 hours: ${report.recentObjectCount}`);
  print(`Kept, not a canonical workspace id: ${report.nonCanonicalPrefixCount}`);
};

const runSweep = async (apply: boolean, deps: WorkspaceStorageSweepDependencies): Promise<{ exitCode: number }> => {
  const report = await reportOrphanedWorkspaceStorage(deps);
  printReport(report, deps.print);
  if (!apply) {
    deps.print("Dry run: nothing was queued. Re-run with --apply to queue the sweep.");
    return { exitCode: 0 };
  }
  if (report.ownership !== "verified") {
    deps.print("Refusing to queue the sweep: the document storage check did not pass.");
    return { exitCode: 1 };
  }
  const receipt = await deps.queue.enqueue(orphanedWorkspaceStorageSweepRequest(null));
  deps.print(receipt.inserted
    ? "Queued the orphan sweep. The worker queues one purge per orphaned workspace."
    : "An orphan sweep is already queued.");
  return { exitCode: 0 };
};

const runWorkspacePurge = async (
  workspaceId: string,
  apply: boolean,
  deps: WorkspaceStorageSweepDependencies,
): Promise<{ exitCode: number }> => {
  const exists = (await deps.owners.existingWorkspaceIds([workspaceId])).has(workspaceId);
  const summary = await deps.storage.summarizeWorkspaceObjects({ workspaceId });
  deps.print(`Workspace ${workspaceId}: ${exists ? "exists in this database" : "not in this database"}`);
  deps.print(`Stored objects: ${summary.objectCount}`);
  if (!apply) {
    deps.print("Dry run: nothing was queued. Re-run with --apply to queue its purge.");
    return { exitCode: 0 };
  }
  if (exists) {
    deps.print("Refusing to queue a purge: the workspace exists in this database.");
    return { exitCode: 1 };
  }
  const receipt = await deps.queue.enqueue(workspaceStoragePurgeRequest(workspaceId));
  deps.print(receipt.inserted
    ? `Queued the purge of workspace ${workspaceId}.`
    : `A purge of workspace ${workspaceId} is already queued.`);
  return { exitCode: 0 };
};

/**
 * Reports, and with `apply` queues, the removal of stored files whose workspace this database no
 * longer has. The script only reads storage and writes jobs; the worker deletes.
 */
export const runWorkspaceStorageSweepCommand = (
  command: WorkspaceStorageSweepCommand,
  deps: WorkspaceStorageSweepDependencies,
): Promise<{ exitCode: number }> =>
  command.kind === "sweep"
    ? runSweep(command.apply, deps)
    : runWorkspacePurge(command.workspaceId, command.apply, deps);
