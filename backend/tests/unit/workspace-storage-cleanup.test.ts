import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_STORAGE_PURGE_JOB,
  handOffWorkspaceStoragePurges,
  workspaceStoragePurgeHandler,
  workspaceStoragePurgeRequest,
} from "../../src/modules/documents/composition.js";
import type { AuditEventInput } from "../../src/modules/audit/contracts/index.js";
import {
  BackgroundJobRuntime,
  DefaultBackgroundJobQueue,
} from "../../src/shared/background-jobs/index.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";
import { InMemoryDocumentStorage } from "../support/fakes.js";
import { InMemoryBackgroundJobStore } from "../support/inMemoryBackgroundJobStore.js";

const START = new Date("2026-10-24T09:00:00.000Z");
/** The in-memory store ignores the executor; production passes the deletion's own transaction. */
const DELETION_TRANSACTION = {} as Db;

const createClock = () => {
  let current = START.getTime();
  return {
    now: () => new Date(current),
    advanceSeconds: (seconds: number) => {
      current += seconds * 1_000;
    },
  };
};

const createLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A database's view of its workspaces: the ones that still exist, and which of them hold uploaded files. */
const createOwners = (input: { existing?: string[]; withUploadedFiles?: string[] } = {}) => {
  const existing = new Set(input.existing ?? []);
  return {
    existing,
    existingWorkspaceIds: vi.fn(async (workspaceIds: readonly string[]) =>
      new Set(workspaceIds.filter((workspaceId) => existing.has(workspaceId)))),
    workspacesWithUploadedFiles: vi.fn(async (limit: number) => (input.withUploadedFiles ?? []).slice(0, limit)),
  };
};

const setup = (options: {
  owners?: ReturnType<typeof createOwners>;
  purge?: { batchSize?: number; batchesPerRun?: number };
} = {}) => {
  const clock = createClock();
  const jobs = new InMemoryBackgroundJobStore(clock);
  const logger = createLogger();
  const queue = new DefaultBackgroundJobQueue({ writer: jobs, wake: { requestDrain: async () => {} }, logger });
  const storage = new InMemoryDocumentStorage();
  const owners = options.owners ?? createOwners();
  const audits: AuditEventInput[] = [];
  const audit = { record: vi.fn(async (event: AuditEventInput) => { audits.push(event); }) };
  const runtime = new BackgroundJobRuntime({
    store: jobs,
    handlers: [
      workspaceStoragePurgeHandler({ storage, owners, queue, audit, logger, now: clock.now, ...options.purge }),
    ],
    logger,
    now: clock.now,
  });
  /** Drains until nothing is due, letting retry delays pass in between. */
  const drainUntilIdle = async () => {
    for (let round = 0; round < 50; round += 1) {
      const result = await runtime.drain({ maxJobs: 100 });
      if (result.claimed === 0) {
        const waiting = [...jobs.rows.values()].filter((row) => row.status === "pending");
        if (waiting.length === 0) return;
        clock.advanceSeconds(24 * 60 * 60);
      }
    }
    throw new Error("background jobs did not settle");
  };
  return { clock, jobs, logger, queue, storage, owners, audits, audit, runtime, drainUntilIdle };
};

const seedObjects = (storage: InMemoryDocumentStorage, workspaceId: string, count: number): string[] => {
  const paths = Array.from({ length: count }, (_, index) =>
    `workspaces/${workspaceId}/documents/${String(index).padStart(4, "0")}-${randomUUID()}`);
  for (const objectPath of paths) storage.put(objectPath);
  return paths;
};

const objectsOf = (storage: InMemoryDocumentStorage, workspaceId: string): string[] =>
  [...storage.objects.keys()].filter((objectPath) => objectPath.startsWith(`workspaces/${workspaceId}/`));

const loggedText = (logger: ReturnType<typeof createLogger>): string =>
  JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);

describe("deleting a workspace's stored files", () => {
  it("deletes every object the workspace held, in bounded passes, after the deletion hands it off", async () => {
    const deleted = randomUUID();
    const kept = randomUUID();
    const harness = setup({ owners: createOwners({ existing: [kept] }), purge: { batchSize: 100, batchesPerRun: 2 } });
    seedObjects(harness.storage, deleted, 250);
    // A file from before storage paths dropped the filename sits one level deeper.
    harness.storage.put(`workspaces/${deleted}/documents/${randomUUID()}/1716000000000-quarterly-report.pdf`);
    harness.storage.put(`workspaces/${deleted}/documents/assistant-logo-${randomUUID()}`);
    seedObjects(harness.storage, kept, 3);

    await handOffWorkspaceStoragePurges(harness.queue)(DELETION_TRANSACTION, [deleted]);
    await harness.drainUntilIdle();

    expect(objectsOf(harness.storage, deleted)).toEqual([]);
    expect(objectsOf(harness.storage, kept)).toHaveLength(3);
    // One pass deletes at most two batches; the rest goes in a rerun of the same job.
    const counts = harness.audits.map((event) => event.metadata?.deletedObjectCount);
    expect(counts).toEqual([200, 52]);
    expect(harness.audits.every((event) =>
      event.eventType === "workspace.stored_files.deleted"
      && event.eventStatus === "success"
      && event.accountId == null
      && event.workspaceId == null
      && event.metadata?.deletedWorkspaceId === deleted)).toBe(true);
    expect(harness.jobs.rows.size).toBe(0);
  });

  it("hands off one purge per workspace, so an organization deletion empties each of them", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const harness = setup();
    seedObjects(harness.storage, first, 2);
    seedObjects(harness.storage, second, 4);

    await handOffWorkspaceStoragePurges(harness.queue)(DELETION_TRANSACTION, [first, second]);
    expect([...harness.jobs.rows.values()].map((row) => [row.kind, row.idempotencyKey]).sort()).toEqual([
      [WORKSPACE_STORAGE_PURGE_JOB.kind, `workspace_deletion:${first}`],
      [WORKSPACE_STORAGE_PURGE_JOB.kind, `workspace_deletion:${second}`],
    ].sort());
    await harness.drainUntilIdle();

    expect(objectsOf(harness.storage, first)).toEqual([]);
    expect(objectsOf(harness.storage, second)).toEqual([]);
    expect(harness.audits.map((event) => [event.metadata?.deletedWorkspaceId, event.metadata?.deletedObjectCount]).sort())
      .toEqual([[first, 2], [second, 4]].sort());
  });

  it("retries a pass whose deletes failed until every object is gone, counting only what went", async () => {
    const workspaceId = randomUUID();
    const harness = setup();
    const [stuck, ...rest] = seedObjects(harness.storage, workspaceId, 5);
    harness.storage.deleteFailures.add(stuck);

    await handOffWorkspaceStoragePurges(harness.queue)(DELETION_TRANSACTION, [workspaceId]);
    await harness.runtime.drain({ maxJobs: 10 });

    expect(objectsOf(harness.storage, workspaceId)).toEqual([stuck]);
    const [waiting] = [...harness.jobs.rows.values()];
    expect(waiting).toMatchObject({ kind: WORKSPACE_STORAGE_PURGE_JOB.kind, status: "pending", attempts: 1 });
    expect(waiting.lastError).toBeTruthy();
    expect(harness.audits.map((event) => event.metadata?.deletedObjectCount)).toEqual([rest.length]);
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, deletedObjectCount: rest.length, failedObjectCount: 1 }),
      expect.any(String),
    );

    harness.storage.deleteFailures.clear();
    await harness.drainUntilIdle();

    expect(objectsOf(harness.storage, workspaceId)).toEqual([]);
    expect(harness.audits.map((event) => event.metadata?.deletedObjectCount)).toEqual([rest.length, 1]);
    expect(harness.jobs.rows.size).toBe(0);
  });

  it("runs again to completion when an earlier pass already deleted the objects", async () => {
    const workspaceId = randomUUID();
    const harness = setup();
    seedObjects(harness.storage, workspaceId, 2);

    await handOffWorkspaceStoragePurges(harness.queue)(DELETION_TRANSACTION, [workspaceId]);
    await harness.drainUntilIdle();
    // A crash between the deletes and the job's completion runs it again over an empty prefix.
    await handOffWorkspaceStoragePurges(harness.queue)(DELETION_TRANSACTION, [workspaceId]);
    await harness.drainUntilIdle();

    expect(harness.audits.map((event) => event.metadata?.deletedObjectCount)).toEqual([2]);
    expect(harness.jobs.rows.size).toBe(0);
  });

  it("keeps the files of a workspace that still exists", async () => {
    const workspaceId = randomUUID();
    const harness = setup({ owners: createOwners({ existing: [workspaceId] }) });
    seedObjects(harness.storage, workspaceId, 3);

    await handOffWorkspaceStoragePurges(harness.queue)(DELETION_TRANSACTION, [workspaceId]);
    await harness.drainUntilIdle();

    expect(objectsOf(harness.storage, workspaceId)).toHaveLength(3);
    expect(harness.audits).toEqual([]);
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }), expect.any(String));
  });

  it("logs and audits counts, never an object's path or filename", async () => {
    const workspaceId = randomUUID();
    const harness = setup();
    const [stuck] = seedObjects(harness.storage, workspaceId, 3);
    harness.storage.put(`workspaces/${workspaceId}/documents/${randomUUID()}/1716000000000-medical-history.pdf`);
    harness.storage.deleteFailures.add(stuck);

    await handOffWorkspaceStoragePurges(harness.queue)(DELETION_TRANSACTION, [workspaceId]);
    await harness.runtime.drain({ maxJobs: 10 });
    harness.storage.deleteFailures.clear();
    await harness.drainUntilIdle();

    const recorded = loggedText(harness.logger) + JSON.stringify(harness.audits);
    expect(recorded).not.toContain(`workspaces/${workspaceId}/`);
    expect(recorded).not.toContain("medical-history");
  });
});

describe("a purge's origin", () => {
  const hoursAgo = (harness: ReturnType<typeof setup>, hours: number) =>
    new Date(harness.clock.now().getTime() - hours * 60 * 60 * 1_000);

  it("deletes a just-deleted workspace's files whatever their age", async () => {
    const workspaceId = randomUUID();
    const harness = setup();
    harness.storage.put(`workspaces/${workspaceId}/documents/${randomUUID()}`, { writtenAt: hoursAgo(harness, 0) });

    await handOffWorkspaceStoragePurges(harness.queue)(DELETION_TRANSACTION, [workspaceId]);
    await harness.drainUntilIdle();

    expect(objectsOf(harness.storage, workspaceId)).toEqual([]);
  });

  it("re-checks an orphan-sweep purge when it runs, and keeps a prefix written to since the operator's report", async () => {
    const settled = randomUUID();
    const reused = randomUUID();
    const harness = setup();
    seedObjects(harness.storage, settled, 2);
    seedObjects(harness.storage, reused, 2);

    await harness.queue.enqueue(workspaceStoragePurgeRequest(settled, "orphan_sweep"));
    await harness.queue.enqueue(workspaceStoragePurgeRequest(reused, "orphan_sweep"));
    // Between the report and the run, something writes to one of them: it is in use somewhere.
    harness.storage.put(`workspaces/${reused}/documents/${randomUUID()}`, { writtenAt: hoursAgo(harness, 2) });
    await harness.drainUntilIdle();

    expect(objectsOf(harness.storage, settled)).toEqual([]);
    expect(objectsOf(harness.storage, reused)).toHaveLength(3);
    expect(harness.audits.map((event) => event.metadata?.deletedWorkspaceId)).toEqual([settled]);
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: reused }), expect.any(String));
  });

  it("purges for an operator without the 24-hour wait, under a key of its own", async () => {
    const workspaceId = randomUUID();
    const harness = setup();
    harness.storage.put(`workspaces/${workspaceId}/documents/${randomUUID()}`, { writtenAt: hoursAgo(harness, 1) });

    await harness.queue.enqueue(workspaceStoragePurgeRequest(workspaceId, "operator"));
    expect([...harness.jobs.rows.values()].map((row) => row.idempotencyKey)).toEqual([`operator:${workspaceId}`]);
    await harness.drainUntilIdle();

    expect(objectsOf(harness.storage, workspaceId)).toEqual([]);
  });

  it("accepts only a canonical lowercase workspace id", () => {
    const workspaceId = randomUUID();

    expect(() => workspaceStoragePurgeRequest(workspaceId.toUpperCase(), "orphan_sweep")).toThrow();
    expect(() => workspaceStoragePurgeRequest("not-a-workspace", "operator")).toThrow();
    expect(workspaceStoragePurgeRequest(workspaceId, "workspace_deletion").payload)
      .toEqual({ workspaceId, origin: "workspace_deletion" });
  });
});
