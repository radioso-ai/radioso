import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  parseWorkspaceStorageSweepArgs,
  runWorkspaceStorageSweepCommand,
} from "../../src/app/cli/workspaceStorageSweepCommand.js";
import type { AuditEventInput } from "../../src/modules/audit/contracts/index.js";
import { WORKSPACE_STORAGE_PURGE_JOB, workspaceStoragePurgeHandler } from "../../src/modules/documents/composition.js";
import { BackgroundJobRuntime, DefaultBackgroundJobQueue } from "../../src/shared/background-jobs/index.js";
import { InMemoryDocumentStorage } from "../support/fakes.js";
import { InMemoryBackgroundJobStore } from "../support/inMemoryBackgroundJobStore.js";

const NOW = new Date("2026-10-25T09:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;

/** One database's view: the workspaces it has, and the ones it holds uploaded files for. */
const createOwners = (input: { existing?: string[]; withUploadedFiles?: string[] } = {}) => {
  const existing = new Set(input.existing ?? []);
  return {
    existingWorkspaceIds: async (workspaceIds: readonly string[]) =>
      new Set(workspaceIds.filter((workspaceId) => existing.has(workspaceId))),
    workspacesWithUploadedFiles: async (limit: number) => (input.withUploadedFiles ?? []).slice(0, limit),
  };
};

const setup = (owners = createOwners()) => {
  let now = NOW;
  const clock = { now: () => now, advanceHours: (hours: number) => { now = new Date(now.getTime() + hours * HOUR_MS); } };
  const storage = new InMemoryDocumentStorage();
  const jobs = new InMemoryBackgroundJobStore(clock);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const queue = new DefaultBackgroundJobQueue({ writer: jobs, wake: { requestDrain: async () => {} }, logger });
  const audits: AuditEventInput[] = [];
  const audit = { record: vi.fn(async (event: AuditEventInput) => { audits.push(event); }) };
  const lines: string[] = [];
  const run = (argv: string[]) =>
    runWorkspaceStorageSweepCommand(parseWorkspaceStorageSweepArgs(argv), {
      storage,
      owners,
      queue,
      audit,
      now: clock.now,
      print: (line) => lines.push(line),
    });
  const worker = new BackgroundJobRuntime({
    store: jobs,
    handlers: [workspaceStoragePurgeHandler({ storage, owners, queue, audit: { record: async () => {} }, logger, now: clock.now })],
    logger,
    now: clock.now,
  });
  const queued = () => [...jobs.rows.values()].map((row) => [row.kind, row.idempotencyKey]);
  const output = () => lines.join("\n");
  return { clock, storage, jobs, lines, audits, audit, run, worker, queued, output };
};

const seed = (storage: InMemoryDocumentStorage, workspaceId: string, count: number, writtenAt?: Date) => {
  for (let index = 0; index < count; index += 1) {
    storage.put(`workspaces/${workspaceId}/documents/${randomUUID()}`, writtenAt ? { writtenAt } : {});
  }
};

const objectsOf = (storage: InMemoryDocumentStorage, workspaceId: string) =>
  [...storage.objects.keys()].filter((objectPath) => objectPath.startsWith(`workspaces/${workspaceId}/`));

describe("parsing the workspace storage sweep's arguments", () => {
  const workspaceId = randomUUID();

  it("is a dry run of the whole sweep unless told otherwise", () => {
    expect(parseWorkspaceStorageSweepArgs([])).toEqual({ kind: "sweep", apply: false });
    // `pnpm run <script> -- <args>` forwards the separator.
    expect(parseWorkspaceStorageSweepArgs(["--"])).toEqual({ kind: "sweep", apply: false });
  });

  it("applies the sweep only against the orphan count the dry run reported", () => {
    expect(parseWorkspaceStorageSweepArgs(["--apply", "--expect-orphans", "9"]))
      .toEqual({ kind: "sweep", apply: true, expectedOrphanCount: 9 });
    expect(parseWorkspaceStorageSweepArgs(["--expect-orphans", "0", "--apply"]))
      .toEqual({ kind: "sweep", apply: true, expectedOrphanCount: 0 });
    expect(() => parseWorkspaceStorageSweepArgs(["--apply"])).toThrow(/--expect-orphans/);
    expect(() => parseWorkspaceStorageSweepArgs(["--expect-orphans", "3"])).toThrow(/--apply/);
    expect(() => parseWorkspaceStorageSweepArgs(["--apply", "--expect-orphans", "-1"])).toThrow();
    expect(() => parseWorkspaceStorageSweepArgs(["--apply", "--expect-orphans", "two"])).toThrow();
  });

  it("targets one workspace's purge with --workspace", () => {
    expect(parseWorkspaceStorageSweepArgs(["--workspace", workspaceId])).toEqual({ kind: "workspace", workspaceId, apply: false });
    expect(parseWorkspaceStorageSweepArgs(["--workspace", workspaceId, "--apply"]))
      .toEqual({ kind: "workspace", workspaceId, apply: true });
    expect(() => parseWorkspaceStorageSweepArgs(["--workspace", workspaceId, "--apply", "--expect-orphans", "1"])).toThrow();
  });

  it("refuses an unknown flag, a missing workspace id, and an id that is not a canonical lowercase UUID", () => {
    expect(() => parseWorkspaceStorageSweepArgs(["--force"])).toThrow(/--force/);
    expect(() => parseWorkspaceStorageSweepArgs(["--workspace"])).toThrow();
    expect(() => parseWorkspaceStorageSweepArgs(["--workspace", workspaceId.toUpperCase()])).toThrow();
    expect(() => parseWorkspaceStorageSweepArgs(["--workspace", "workspace-1"])).toThrow();
  });
});

describe("the workspace storage sweep script", () => {
  it("reports counts on a dry run and queues, records and deletes nothing", async () => {
    const live = randomUUID();
    const orphaned = randomUUID();
    const fresh = randomUUID();
    const harness = setup(createOwners({ existing: [live], withUploadedFiles: [live] }));
    seed(harness.storage, live, 1);
    seed(harness.storage, orphaned, 3);
    seed(harness.storage, fresh, 1, new Date(NOW.getTime() - HOUR_MS));
    seed(harness.storage, orphaned.toUpperCase(), 1);
    harness.storage.put("workspaces/not-a-workspace/documents/leftover");
    const before = harness.storage.objects.size;

    expect(await harness.run([])).toEqual({ exitCode: 0 });

    const text = harness.output();
    expect(text).toMatch(/Document storage check: verified/);
    expect(text).toMatch(/Workspace prefixes scanned: 5/);
    expect(text).toMatch(/Orphaned workspaces: 1 \(3 objects\)/);
    expect(text).toMatch(/Kept, workspace exists in this database: 1/);
    expect(text).toMatch(/Kept, an object written in the last 24 hours: 1/);
    expect(text).toMatch(/Kept, not a canonical workspace id: 2/);
    expect(text).toMatch(/--apply --expect-orphans 1/);
    // Counts only: the report names no workspace and no object.
    expect(text).not.toContain(orphaned);
    expect(text).not.toContain("workspaces/");
    expect(harness.queued()).toEqual([]);
    expect(harness.audits).toEqual([]);
    expect(harness.storage.objects.size).toBe(before);
  });

  it("reports another database's live workspaces as orphans when two deployments share one store", async () => {
    // Why the sweep is a manual step: this database's own files pass the ownership check, and the
    // other deployment's workspaces, which this database has never heard of, read as orphaned.
    const ours = randomUUID();
    const theirs = [randomUUID(), randomUUID()];
    const harness = setup(createOwners({ existing: [ours], withUploadedFiles: [ours] }));
    seed(harness.storage, ours, 2);
    for (const workspaceId of theirs) seed(harness.storage, workspaceId, 2);
    const before = harness.storage.objects.size;

    expect(await harness.run([])).toEqual({ exitCode: 0 });

    expect(harness.output()).toMatch(/Document storage check: verified/);
    expect(harness.output()).toMatch(/Orphaned workspaces: 2 \(4 objects\)/);
    expect(harness.queued()).toEqual([]);
    expect(harness.storage.objects.size).toBe(before);
  });

  it("queues exactly the purges of the report it prints, and records the run", async () => {
    const live = randomUUID();
    const orphans = [randomUUID(), randomUUID()];
    const fresh = randomUUID();
    const harness = setup(createOwners({ existing: [live], withUploadedFiles: [live] }));
    seed(harness.storage, live, 1);
    for (const workspaceId of orphans) seed(harness.storage, workspaceId, 2);
    seed(harness.storage, fresh, 1, new Date(NOW.getTime() - HOUR_MS));

    expect(await harness.run(["--apply", "--expect-orphans", "2"])).toEqual({ exitCode: 0 });

    expect(harness.output()).toMatch(/Orphaned workspaces: 2 \(4 objects\)/);
    expect(harness.output()).toMatch(/Queued 2 purges/);
    expect(harness.queued().sort()).toEqual(
      orphans.map((workspaceId) => [WORKSPACE_STORAGE_PURGE_JOB.kind, `orphan_sweep:${workspaceId}`]).sort(),
    );
    expect(harness.audits).toEqual([{
      accountId: null,
      workspaceId: null,
      eventType: "workspace.stored_files.sweep_queued",
      eventStatus: "success",
      metadata: {
        origin: "cli",
        principalType: "operator",
        orphanedWorkspaceCount: 2,
        orphanedObjectCount: 4,
        queuedPurgeCount: 2,
        alreadyQueuedPurgeCount: 0,
      },
    }]);
    // The script deletes nothing itself; the worker's purges do, and keep what is in use.
    expect(harness.storage.objects.size).toBe(6);
    await harness.worker.drain({ maxJobs: 10 });
    for (const workspaceId of orphans) expect(objectsOf(harness.storage, workspaceId)).toEqual([]);
    expect(objectsOf(harness.storage, fresh)).toHaveLength(1);
    expect(objectsOf(harness.storage, live)).toHaveLength(1);
  });

  it("refuses --apply when the orphan count differs from the one the operator reviewed", async () => {
    const live = randomUUID();
    const harness = setup(createOwners({ existing: [live], withUploadedFiles: [live] }));
    seed(harness.storage, live, 1);
    seed(harness.storage, randomUUID(), 2);
    seed(harness.storage, randomUUID(), 1);

    expect(await harness.run(["--apply", "--expect-orphans", "1"])).toEqual({ exitCode: 1 });

    expect(harness.output()).toMatch(/Orphaned workspaces: 2/);
    expect(harness.output()).toMatch(/Refusing.*expected 1.*found 2/);
    expect(harness.queued()).toEqual([]);
    expect(harness.audits).toEqual([]);
  });

  it("never queues a workspace the dry run kept as recent, even once it ages past a day", async () => {
    // The operator reviewed a report that kept this prefix; by the time --apply runs it is old enough,
    // so it is now an orphan the operator did not count, and the run refuses.
    const live = randomUUID();
    const aging = randomUUID();
    const harness = setup(createOwners({ existing: [live], withUploadedFiles: [live] }));
    seed(harness.storage, live, 1);
    seed(harness.storage, aging, 1, new Date(NOW.getTime() - 20 * HOUR_MS));

    expect(await harness.run([])).toEqual({ exitCode: 0 });
    expect(harness.output()).toMatch(/Orphaned workspaces: 0/);
    harness.clock.advanceHours(6);

    expect(await harness.run(["--apply", "--expect-orphans", "0"])).toEqual({ exitCode: 1 });
    expect(harness.queued()).toEqual([]);
  });

  it("refuses --apply when the store holds none of this database's files, or there is nothing to check", async () => {
    const live = randomUUID();
    const mismatched = setup(createOwners({ existing: [live], withUploadedFiles: [live] }));
    seed(mismatched.storage, randomUUID(), 2);

    expect(await mismatched.run(["--apply", "--expect-orphans", "1"])).toEqual({ exitCode: 1 });
    expect(mismatched.output()).toMatch(/Document storage check: failed/);
    expect(mismatched.output()).toMatch(/Refusing/);
    expect(mismatched.queued()).toEqual([]);

    const empty = setup(createOwners());
    seed(empty.storage, randomUUID(), 1);

    expect(await empty.run(["--apply", "--expect-orphans", "1"])).toEqual({ exitCode: 1 });
    expect(empty.output()).toMatch(/Document storage check: skipped/);
    expect(empty.queued()).toEqual([]);
  });

  it("re-queues one deleted workspace's purge with --workspace, dry run first, and records it", async () => {
    const gone = randomUUID();
    const harness = setup();
    seed(harness.storage, gone, 2, new Date(NOW.getTime() - 60 * 1_000));

    expect(await harness.run(["--workspace", gone])).toEqual({ exitCode: 0 });
    expect(harness.output()).toMatch(/not in this database/);
    expect(harness.output()).toMatch(/Stored objects: 2/);
    expect(harness.queued()).toEqual([]);
    expect(harness.audits).toEqual([]);

    // A targeted purge is the operator's call: no 24-hour wait.
    expect(await harness.run(["--workspace", gone, "--apply"])).toEqual({ exitCode: 0 });
    expect(harness.queued()).toEqual([[WORKSPACE_STORAGE_PURGE_JOB.kind, `operator:${gone}`]]);
    expect(harness.audits).toEqual([{
      accountId: null,
      workspaceId: null,
      eventType: "workspace.stored_files.purge_queued",
      eventStatus: "success",
      metadata: { origin: "cli", principalType: "operator", deletedWorkspaceId: gone, storedObjectCount: 2, queued: true },
    }]);
    await harness.worker.drain({ maxJobs: 10 });
    expect(objectsOf(harness.storage, gone)).toEqual([]);
  });

  it("refuses to queue a purge for a workspace that exists in this database", async () => {
    const live = randomUUID();
    const harness = setup(createOwners({ existing: [live] }));
    seed(harness.storage, live, 1);

    expect(await harness.run(["--workspace", live, "--apply"])).toEqual({ exitCode: 1 });
    expect(harness.output()).toMatch(/exists in this database/);
    expect(harness.queued()).toEqual([]);
    expect(harness.audits).toEqual([]);
  });

  it("exits non-zero when the queued purges could not be recorded", async () => {
    const live = randomUUID();
    const harness = setup(createOwners({ existing: [live], withUploadedFiles: [live] }));
    seed(harness.storage, live, 1);
    seed(harness.storage, randomUUID(), 1);
    harness.audit.record.mockRejectedValueOnce(new Error("audit unavailable"));

    expect(await harness.run(["--apply", "--expect-orphans", "1"])).toEqual({ exitCode: 1 });
    expect(harness.output()).toMatch(/could not be recorded/);
    expect(harness.queued()).toHaveLength(1);
  });
});
