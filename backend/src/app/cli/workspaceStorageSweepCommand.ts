import type { AuditEventInput } from "../../modules/audit/contracts/index.js";
import {
  reportOrphanedWorkspaceStorage,
  workspaceStoragePurgeRequest,
  type OrphanedWorkspaceStorageReport,
} from "../../modules/documents/composition.js";
import {
  isCanonicalWorkspaceId,
  type DocumentStorageInventoryPort,
  type DocumentStorageOwnersPort,
} from "../../modules/documents/contracts/index.js";
import type { BackgroundJobQueue } from "../../shared/background-jobs/index.js";

/**
 * What one run of the command does. Every form is a dry run unless `apply` is set, and applying the
 * sweep names the orphan count the operator reviewed in a dry run.
 */
type WorkspaceStorageSweepCommand =
  | { kind: "sweep"; apply: false }
  | { kind: "sweep"; apply: true; expectedOrphanCount: number }
  | { kind: "workspace"; workspaceId: string; apply: boolean };

const USAGE =
  "Usage: workspaceStorageSweep [--apply --expect-orphans <count>] | --workspace <workspace id> [--apply]";
const COUNT = /^(0|[1-9][0-9]*)$/;

export const parseWorkspaceStorageSweepArgs = (argv: readonly string[]): WorkspaceStorageSweepCommand => {
  let apply = false;
  let workspaceId: string | null = null;
  let expectedOrphanCount: number | null = null;
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
    } else if (argument === "--expect-orphans") {
      const value = argv[index + 1];
      if (value === undefined || !COUNT.test(value)) {
        throw new Error(`--expect-orphans needs the orphaned workspace count from a dry run. ${USAGE}`);
      }
      expectedOrphanCount = Number(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${argument}. ${USAGE}`);
    }
  }
  if (workspaceId !== null) {
    if (expectedOrphanCount !== null) throw new Error(`--expect-orphans goes with the sweep, not --workspace. ${USAGE}`);
    return { kind: "workspace", workspaceId, apply };
  }
  if (!apply) {
    if (expectedOrphanCount !== null) throw new Error(`--expect-orphans goes with --apply. ${USAGE}`);
    return { kind: "sweep", apply: false };
  }
  if (expectedOrphanCount === null) {
    throw new Error(`--apply needs --expect-orphans with the orphaned workspace count a dry run reported. ${USAGE}`);
  }
  return { kind: "sweep", apply: true, expectedOrphanCount };
};

interface WorkspaceStorageSweepDependencies {
  storage: DocumentStorageInventoryPort;
  owners: DocumentStorageOwnersPort;
  queue: Pick<BackgroundJobQueue, "enqueue">;
  audit: { record(event: AuditEventInput): Promise<void> };
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
  print(`Orphaned workspaces: ${report.orphanedWorkspaceIds.length} (${report.orphanedObjectCount} objects)`);
  print(`Kept, workspace exists in this database: ${report.liveWorkspaceCount}`);
  print(`Kept, an object written in the last 24 hours: ${report.recentObjectCount}`);
  print(`Kept, not a canonical workspace id: ${report.nonCanonicalPrefixCount}`);
};

/** The work is queued already, so a failed audit write is said plainly and fails the run. */
const recordRun = async (deps: WorkspaceStorageSweepDependencies, event: AuditEventInput): Promise<boolean> => {
  try {
    await deps.audit.record(event);
    return true;
  } catch {
    deps.print("The queued purges stand, but the audit event could not be recorded.");
    return false;
  }
};

const runSweep = async (
  command: Extract<WorkspaceStorageSweepCommand, { kind: "sweep" }>,
  deps: WorkspaceStorageSweepDependencies,
): Promise<{ exitCode: number }> => {
  const report = await reportOrphanedWorkspaceStorage(deps);
  printReport(report, deps.print);
  const found = report.orphanedWorkspaceIds.length;
  if (!command.apply) {
    deps.print(`Dry run: nothing was queued. To queue these purges, run again with --apply --expect-orphans ${found}.`);
    return { exitCode: 0 };
  }
  if (report.ownership !== "verified") {
    deps.print("Refusing to queue purges: the document storage check did not pass.");
    return { exitCode: 1 };
  }
  if (found !== command.expectedOrphanCount) {
    deps.print(
      `Refusing to queue purges: expected ${command.expectedOrphanCount} orphaned workspaces, found ${found}. ` +
        "Run the dry run again and review it.",
    );
    return { exitCode: 1 };
  }
  // Exactly the workspaces of the report just printed: nothing scans the store again on its own.
  let queued = 0;
  for (const workspaceId of report.orphanedWorkspaceIds) {
    if ((await deps.queue.enqueue(workspaceStoragePurgeRequest(workspaceId, "orphan_sweep"))).inserted) queued += 1;
  }
  deps.print(`Queued ${queued} purges (${found - queued} already queued). Each re-checks its workspace when it runs.`);
  const recorded = await recordRun(deps, {
    accountId: null,
    workspaceId: null,
    eventType: "workspace.stored_files.sweep_queued",
    eventStatus: "success",
    metadata: {
      origin: "cli",
      principalType: "operator",
      orphanedWorkspaceCount: found,
      orphanedObjectCount: report.orphanedObjectCount,
      queuedPurgeCount: queued,
      alreadyQueuedPurgeCount: found - queued,
    },
  });
  return { exitCode: recorded ? 0 : 1 };
};

const runWorkspacePurge = async (
  command: Extract<WorkspaceStorageSweepCommand, { kind: "workspace" }>,
  deps: WorkspaceStorageSweepDependencies,
): Promise<{ exitCode: number }> => {
  const { workspaceId } = command;
  const exists = (await deps.owners.existingWorkspaceIds([workspaceId])).has(workspaceId);
  const summary = await deps.storage.summarizeWorkspaceObjects({ workspaceId });
  deps.print(`Workspace ${workspaceId}: ${exists ? "exists in this database" : "not in this database"}`);
  deps.print(`Stored objects: ${summary.objectCount}`);
  if (!command.apply) {
    deps.print("Dry run: nothing was queued. Re-run with --apply to queue its purge.");
    return { exitCode: 0 };
  }
  if (exists) {
    deps.print("Refusing to queue a purge: the workspace exists in this database.");
    return { exitCode: 1 };
  }
  const receipt = await deps.queue.enqueue(workspaceStoragePurgeRequest(workspaceId, "operator"));
  deps.print(receipt.inserted
    ? `Queued the purge of workspace ${workspaceId}.`
    : `A purge of workspace ${workspaceId} is already queued.`);
  const recorded = await recordRun(deps, {
    accountId: null,
    workspaceId: null,
    eventType: "workspace.stored_files.purge_queued",
    eventStatus: "success",
    metadata: {
      origin: "cli",
      principalType: "operator",
      deletedWorkspaceId: workspaceId,
      storedObjectCount: summary.objectCount,
      queued: receipt.inserted,
    },
  });
  return { exitCode: recorded ? 0 : 1 };
};

/**
 * Reports, and with `apply` queues, the removal of stored files whose workspace this database no
 * longer has. The command only reads storage and writes jobs; the worker deletes.
 */
export const runWorkspaceStorageSweepCommand = (
  command: WorkspaceStorageSweepCommand,
  deps: WorkspaceStorageSweepDependencies,
): Promise<{ exitCode: number }> =>
  command.kind === "sweep" ? runSweep(command, deps) : runWorkspacePurge(command, deps);
