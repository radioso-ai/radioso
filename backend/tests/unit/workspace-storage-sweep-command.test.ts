import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  parseWorkspaceStorageSweepArgs,
  runWorkspaceStorageSweepCommand,
} from "../../src/app/cli/workspaceStorageSweepCommand.js";
import {
  ORPHANED_WORKSPACE_STORAGE_SWEEP_JOB,
  WORKSPACE_STORAGE_PURGE_JOB,
} from "../../src/modules/documents/composition.js";
import { DefaultBackgroundJobQueue } from "../../src/shared/background-jobs/index.js";
import { InMemoryDocumentStorage } from "../support/fakes.js";
import { InMemoryBackgroundJobStore } from "../support/inMemoryBackgroundJobStore.js";

const NOW = new Date("2026-10-25T09:00:00.000Z");

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
  const storage = new InMemoryDocumentStorage();
  const jobs = new InMemoryBackgroundJobStore({ now: () => NOW });
  const queue = new DefaultBackgroundJobQueue({
    writer: jobs,
    wake: { requestDrain: async () => {} },
    logger: { warn: vi.fn() },
  });
  const lines: string[] = [];
  const run = (argv: string[]) =>
    runWorkspaceStorageSweepCommand(parseWorkspaceStorageSweepArgs(argv), {
      storage,
      owners,
      queue,
      now: () => NOW,
      print: (line) => lines.push(line),
    });
  const queued = () => [...jobs.rows.values()].map((row) => [row.kind, row.idempotencyKey]);
  return { storage, jobs, lines, run, queued };
};

const seed = (storage: InMemoryDocumentStorage, workspaceId: string, count: number, writtenAt?: Date) => {
  for (let index = 0; index < count; index += 1) {
    storage.put(`workspaces/${workspaceId}/documents/${randomUUID()}`, writtenAt ? { writtenAt } : {});
  }
};

const output = (lines: string[]) => lines.join("\n");

describe("parsing the workspace storage sweep's arguments", () => {
  const workspaceId = randomUUID();

  it("is a dry run of the whole sweep unless told otherwise", () => {
    expect(parseWorkspaceStorageSweepArgs([])).toEqual({ kind: "sweep", apply: false });
    expect(parseWorkspaceStorageSweepArgs(["--apply"])).toEqual({ kind: "sweep", apply: true });
    // `pnpm run <script> -- --apply` forwards the separator.
    expect(parseWorkspaceStorageSweepArgs(["--", "--apply"])).toEqual({ kind: "sweep", apply: true });
  });

  it("targets one workspace's purge with --workspace", () => {
    expect(parseWorkspaceStorageSweepArgs(["--workspace", workspaceId])).toEqual({ kind: "workspace", workspaceId, apply: false });
    expect(parseWorkspaceStorageSweepArgs(["--workspace", workspaceId, "--apply"]))
      .toEqual({ kind: "workspace", workspaceId, apply: true });
  });

  it("refuses an unknown flag, a missing workspace id, and an id that is not a canonical lowercase UUID", () => {
    expect(() => parseWorkspaceStorageSweepArgs(["--force"])).toThrow(/--force/);
    expect(() => parseWorkspaceStorageSweepArgs(["--workspace"])).toThrow();
    expect(() => parseWorkspaceStorageSweepArgs(["--workspace", workspaceId.toUpperCase()])).toThrow();
    expect(() => parseWorkspaceStorageSweepArgs(["--workspace", "workspace-1"])).toThrow();
  });
});

describe("the workspace storage sweep script", () => {
  it("reports counts on a dry run and queues and deletes nothing", async () => {
    const live = randomUUID();
    const orphaned = randomUUID();
    const fresh = randomUUID();
    const harness = setup(createOwners({ existing: [live], withUploadedFiles: [live] }));
    seed(harness.storage, live, 1);
    seed(harness.storage, orphaned, 3);
    seed(harness.storage, fresh, 1, new Date(NOW.getTime() - 60 * 60 * 1_000));
    seed(harness.storage, orphaned.toUpperCase(), 1);
    const before = harness.storage.objects.size;

    expect(await harness.run([])).toEqual({ exitCode: 0 });

    const text = output(harness.lines);
    expect(text).toMatch(/Document storage check: verified/);
    expect(text).toMatch(/Workspace prefixes scanned: 4/);
    expect(text).toMatch(/Orphaned workspaces: 1 \(3 objects\)/);
    expect(text).toMatch(/Kept, workspace exists in this database: 1/);
    expect(text).toMatch(/Kept, an object written in the last 24 hours: 1/);
    expect(text).toMatch(/Kept, not a canonical workspace id: 1/);
    expect(text).toMatch(/Dry run/);
    // Counts only: the report names no workspace and no object.
    expect(text).not.toContain(orphaned);
    expect(text).not.toContain("workspaces/");
    expect(harness.queued()).toEqual([]);
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

    expect(output(harness.lines)).toMatch(/Document storage check: verified/);
    expect(output(harness.lines)).toMatch(/Orphaned workspaces: 2 \(4 objects\)/);
    expect(harness.queued()).toEqual([]);
    expect(harness.storage.objects.size).toBe(before);
  });

  it("queues the sweep with --apply once the store holds this database's files", async () => {
    const live = randomUUID();
    const harness = setup(createOwners({ existing: [live], withUploadedFiles: [live] }));
    seed(harness.storage, live, 1);
    seed(harness.storage, randomUUID(), 2);

    expect(await harness.run(["--apply"])).toEqual({ exitCode: 0 });
    expect(await harness.run(["--apply"])).toEqual({ exitCode: 0 });

    expect(harness.queued()).toEqual([[ORPHANED_WORKSPACE_STORAGE_SWEEP_JOB.kind, "start"]]);
    expect(output(harness.lines)).toMatch(/Orphaned workspaces: 1 \(2 objects\)/);
    expect(output(harness.lines)).toMatch(/Queued the orphan sweep/);
    expect(output(harness.lines)).toMatch(/already queued/);
    // The sweep runs in the worker; the script itself deletes nothing.
    expect(harness.storage.objects.size).toBe(3);
  });

  it("refuses --apply when the store holds none of this database's files, or there is nothing to check", async () => {
    const live = randomUUID();
    const mismatched = setup(createOwners({ existing: [live], withUploadedFiles: [live] }));
    seed(mismatched.storage, randomUUID(), 2);

    expect(await mismatched.run(["--apply"])).toEqual({ exitCode: 1 });
    expect(output(mismatched.lines)).toMatch(/Document storage check: failed/);
    expect(output(mismatched.lines)).toMatch(/Refusing to queue the sweep/);
    expect(mismatched.queued()).toEqual([]);

    const empty = setup(createOwners());
    seed(empty.storage, randomUUID(), 1);

    expect(await empty.run(["--apply"])).toEqual({ exitCode: 1 });
    expect(output(empty.lines)).toMatch(/Document storage check: skipped/);
    expect(empty.queued()).toEqual([]);
  });

  it("re-queues one deleted workspace's purge with --workspace, dry run first", async () => {
    const gone = randomUUID();
    const harness = setup();
    seed(harness.storage, gone, 2, new Date(NOW.getTime() - 60 * 1_000));

    expect(await harness.run(["--workspace", gone])).toEqual({ exitCode: 0 });
    expect(output(harness.lines)).toMatch(/not in this database/);
    expect(output(harness.lines)).toMatch(/Stored objects: 2/);
    expect(harness.queued()).toEqual([]);

    // A targeted purge is the operator's call: no 24-hour wait.
    expect(await harness.run(["--workspace", gone, "--apply"])).toEqual({ exitCode: 0 });
    expect(harness.queued()).toEqual([[WORKSPACE_STORAGE_PURGE_JOB.kind, gone]]);
    expect(harness.storage.objects.size).toBe(2);
  });

  it("refuses to queue a purge for a workspace that exists in this database", async () => {
    const live = randomUUID();
    const harness = setup(createOwners({ existing: [live] }));
    seed(harness.storage, live, 1);

    expect(await harness.run(["--workspace", live, "--apply"])).toEqual({ exitCode: 1 });
    expect(output(harness.lines)).toMatch(/exists in this database/);
    expect(harness.queued()).toEqual([]);
  });
});
