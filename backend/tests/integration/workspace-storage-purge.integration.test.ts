import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createWorkspaceDeletionHooks } from "../../src/app/composition/workspaceDeletion.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AuditEventRepository } from "../../src/db/repositories/auditEventRepository.js";
import { BackgroundJobRepository } from "../../src/db/repositories/backgroundJobRepository.js";
import { DocumentStorageOwnerRepository } from "../../src/db/repositories/documentStorageOwnerRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AuditService } from "../../src/modules/audit/composition.js";
import {
  LocalDocumentStorage,
  ORPHANED_WORKSPACE_STORAGE_SWEEP_JOB,
  WORKSPACE_STORAGE_PURGE_JOB,
  orphanedWorkspaceStorageSweepHandler,
  orphanedWorkspaceStorageSweepRequest,
  workspaceStoragePurgeHandler,
} from "../../src/modules/documents/composition.js";
import type { DocumentStorageAdapter } from "../../src/modules/documents/contracts/index.js";
import {
  BackgroundJobRuntime,
  DefaultBackgroundJobQueue,
  NoopBackgroundJobWake,
} from "../../src/shared/background-jobs/index.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const quietLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describeIntegration("workspace stored-file deletion (Postgres)", () => {
  // A database of its own: migration 240 queues the one-time sweep, and the test reads that job
  // before any worker in another file could claim it.
  const testDatabaseName = `workspace_storage_${randomUUID().replaceAll("-", "")}_test`;
  let database: Database;
  let root: string;
  let storage: LocalDocumentStorage;
  /** The store the worker deletes through; a test can make its deletes fail. */
  let failingDeletes = false;
  let worker: BackgroundJobRuntime;
  let lifecycle: PersonalCredentialLifecycleRepository;
  let rollingBack: PersonalCredentialLifecycleRepository;
  let owners: DocumentStorageOwnerRepository;
  const wake = { requestDrain: vi.fn(async () => {}) };
  let queuedByMigration: Array<{ idempotency_key: string | null; payload: unknown; status: string }>;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`CREATE DATABASE "${testDatabaseName}" TEMPLATE template0`);
    } finally {
      await admin.end();
    }
    const url = new URL(integrationDatabaseUrl);
    url.pathname = `/${testDatabaseName}`;
    url.searchParams.delete("options");
    database = new Database(url.toString());
    await runAllTestMigrations(database);

    queuedByMigration = await database.query(
      "SELECT idempotency_key, payload, status FROM background_jobs WHERE kind = $1",
      [ORPHANED_WORKSPACE_STORAGE_SWEEP_JOB.kind],
    );
    // Each test queues its own sweep; the migration's would otherwise run inside the first drain.
    await database.query("DELETE FROM background_jobs WHERE kind = $1", [ORPHANED_WORKSPACE_STORAGE_SWEEP_JOB.kind]);

    root = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-workspace-storage-"));
    storage = new LocalDocumentStorage(root);
    const workerStorage: DocumentStorageAdapter = {
      upload: (input) => storage.upload(input),
      read: (input) => storage.read(input),
      delete: async (input) => {
        if (failingDeletes) throw new Error("storage unavailable");
        await storage.delete(input);
      },
      listWorkspaceObjects: (input) => storage.listWorkspaceObjects(input),
      listStoredWorkspaces: (input) => storage.listStoredWorkspaces(input),
    };

    const logger = quietLogger();
    const jobs = new BackgroundJobRepository(database.kysely);
    const queue = new DefaultBackgroundJobQueue({ writer: jobs, wake, logger });
    const hooks = createWorkspaceDeletionHooks({ queue });
    lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, hooks.inTransaction, hooks.afterCommit);
    rollingBack = new PersonalCredentialLifecycleRepository(database.kysely, async (trx, workspaceIds) => {
      await hooks.inTransaction(trx, workspaceIds);
      throw new Error("deletion failed after the hand-off");
    });
    owners = new DocumentStorageOwnerRepository(database.kysely);
    const audit = new AuditService(createLogger("silent"), new AuditEventRepository(database.kysely));
    worker = new BackgroundJobRuntime({
      store: jobs,
      handlers: [
        workspaceStoragePurgeHandler({ storage: workerStorage, owners, queue, audit, logger }),
        orphanedWorkspaceStorageSweepHandler({ storage: workerStorage, owners, queue, logger }),
      ],
      logger,
    });
  }, 60_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    if (root) await fs.rm(root, { recursive: true, force: true });
  }, 30_000);

  const seedAccount = async (workspaceCount: number) => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Storage",
      email: `storage-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspaces = new WorkspaceRepository(database.kysely);
    const workspaceIds: string[] = [];
    for (let index = 0; index < workspaceCount; index += 1) {
      workspaceIds.push((await workspaces.create(account.id, `Storage ${index}`)).id);
    }
    return { accountId: account.id, workspaceIds };
  };

  /** Uploads a file the way an import does and records the document row that points at it. */
  const uploadDocument = async (workspaceId: string) => {
    const stored = await storage.upload({
      workspaceId,
      documentId: randomUUID(),
      filename: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("stored file"),
    });
    await database.query(
      `INSERT INTO documents (id, title, source_content, markdown_content, status, workspace_id, source_kind,
         source_storage_bucket, source_storage_object)
       VALUES ($1, 'Notes', '', '', 'ready', $2, 'uploaded_file', $3, $4)`,
      [randomUUID(), workspaceId, stored.bucket, stored.objectPath],
    );
    return stored;
  };

  const storedObjects = (workspaceId: string) => storage.listWorkspaceObjects({ workspaceId, limit: 100 });

  const purgeJobs = (workspaceId: string) =>
    database.query<{ id: string; status: string; attempts: number; last_error: string | null }>(
      "SELECT id, status, attempts, last_error FROM background_jobs WHERE kind = $1 AND idempotency_key = $2",
      [WORKSPACE_STORAGE_PURGE_JOB.kind, workspaceId],
    );

  const deletionAudits = (workspaceId: string) =>
    database.query<{ account_id: string | null; workspace_id: string | null; metadata_json: Record<string, unknown> }>(
      `SELECT account_id, workspace_id, metadata_json FROM audit_events
       WHERE event_type = 'workspace.stored_files.deleted' AND metadata_json->>'deletedWorkspaceId' = $1`,
      [workspaceId],
    );

  const workspaceDeletedEvent = (accountId: string) => ({
    accountId,
    workspaceId: null,
    eventType: "workspace.deleted",
    eventStatus: "success" as const,
    metadata: {},
  });

  it("migration 240 leaves the one-time orphan sweep queued for the worker", () => {
    const expected = orphanedWorkspaceStorageSweepRequest(null);
    expect(queuedByMigration).toEqual([
      { idempotency_key: expected.idempotencyKey, payload: expected.payload, status: "pending" },
    ]);
    expect(ORPHANED_WORKSPACE_STORAGE_SWEEP_JOB.payload.safeParse(queuedByMigration[0]?.payload).success).toBe(true);
  });

  it("commits a workspace's stored-file purge with its deletion, and the worker deletes the files after the commit", async () => {
    const { accountId, workspaceIds: [deleted, kept] } = await seedAccount(2);
    await uploadDocument(deleted);
    await uploadDocument(deleted);
    await uploadDocument(kept);

    wake.requestDrain.mockClear();
    expect(await lifecycle.deleteWorkspace({ accountId, workspaceId: deleted, auditEvent: workspaceDeletedEvent(accountId) }))
      .toBe(true);

    // The deletion handed the files off and woke the worker once it committed; it did not delete them inline.
    expect(await purgeJobs(deleted)).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(wake.requestDrain).toHaveBeenCalledTimes(1);
    expect(await storedObjects(deleted)).toHaveLength(2);

    await worker.drain({ maxJobs: 10 });

    expect(await storedObjects(deleted)).toEqual([]);
    expect(await storedObjects(kept)).toHaveLength(1);
    expect(await purgeJobs(deleted)).toEqual([]);
    expect(await deletionAudits(deleted)).toEqual([
      { account_id: null, workspace_id: null, metadata_json: expect.objectContaining({ deletedObjectCount: 2 }) },
    ]);
  });

  it("hands nothing off when the deletion rolls back, so every file stays with its workspace", async () => {
    const { accountId, workspaceIds: [workspaceId] } = await seedAccount(2);
    await uploadDocument(workspaceId);

    wake.requestDrain.mockClear();
    await expect(rollingBack.deleteWorkspace({ accountId, workspaceId, auditEvent: workspaceDeletedEvent(accountId) }))
      .rejects.toThrow();
    expect(wake.requestDrain).not.toHaveBeenCalled();

    expect(await owners.existingWorkspaceIds([workspaceId])).toEqual(new Set([workspaceId]));
    expect(await purgeJobs(workspaceId)).toEqual([]);
    expect(await storedObjects(workspaceId)).toHaveLength(1);
  });

  it("keeps a purge whose deletes failed queued, and retries it until the files are gone", async () => {
    const { accountId, workspaceIds: [workspaceId] } = await seedAccount(2);
    await uploadDocument(workspaceId);
    await lifecycle.deleteWorkspace({ accountId, workspaceId, auditEvent: workspaceDeletedEvent(accountId) });

    failingDeletes = true;
    try {
      await worker.drain({ maxJobs: 10 });
    } finally {
      failingDeletes = false;
    }

    const [waiting] = await purgeJobs(workspaceId);
    expect(waiting).toMatchObject({ status: "pending", attempts: 1 });
    expect(waiting.last_error).toBeTruthy();
    expect(await storedObjects(workspaceId)).toHaveLength(1);

    await database.query("UPDATE background_jobs SET available_at = now() WHERE id = $1", [waiting.id]);
    await worker.drain({ maxJobs: 10 });

    expect(await storedObjects(workspaceId)).toEqual([]);
    expect(await purgeJobs(workspaceId)).toEqual([]);
  });

  it("hands off a purge for every workspace of a deleted organization", async () => {
    const { accountId, workspaceIds } = await seedAccount(2);
    for (const workspaceId of workspaceIds) await uploadDocument(workspaceId);

    expect(await lifecycle.deleteAccount({
      accountId,
      auditEvent: { accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
    })).toBe(true);
    await worker.drain({ maxJobs: 10 });

    for (const workspaceId of workspaceIds) {
      expect(await storedObjects(workspaceId)).toEqual([]);
      expect(await deletionAudits(workspaceId)).toEqual([
        expect.objectContaining({ metadata_json: expect.objectContaining({ deletedObjectCount: 1 }) }),
      ]);
    }
  });

  it("the sweep purges the files of workspaces this database no longer has, and keeps every live one", async () => {
    const { workspaceIds: [live] } = await seedAccount(1);
    await uploadDocument(live);
    const orphaned = randomUUID();
    await storage.upload({ workspaceId: orphaned, documentId: randomUUID(), filename: "a", mimeType: "text/plain", buffer: Buffer.from("a") });

    await new DefaultBackgroundJobQueue({
      writer: new BackgroundJobRepository(database.kysely),
      wake: new NoopBackgroundJobWake(),
      logger: quietLogger(),
    }).enqueue(orphanedWorkspaceStorageSweepRequest(null));
    // The sweep queues one purge per orphaned workspace; the next drain runs them.
    await worker.drain({ maxJobs: 10 });
    await worker.drain({ maxJobs: 10 });

    expect(await storedObjects(orphaned)).toEqual([]);
    expect(await storedObjects(live)).toHaveLength(1);
    expect(await deletionAudits(orphaned)).toEqual([
      expect.objectContaining({ metadata_json: expect.objectContaining({ deletedObjectCount: 1 }) }),
    ]);
  });

  it("reads which workspaces still exist and which of them hold uploaded files", async () => {
    const { workspaceIds: [withFile, withoutFile] } = await seedAccount(2);
    await uploadDocument(withFile);
    const gone = randomUUID();

    expect(await owners.existingWorkspaceIds([withFile, withoutFile, gone])).toEqual(new Set([withFile, withoutFile]));
    expect(await owners.existingWorkspaceIds([])).toEqual(new Set());
    const holding = await owners.workspacesWithUploadedFiles(1_000);
    expect(holding).toContain(withFile);
    expect(holding).not.toContain(withoutFile);
    expect(await owners.workspacesWithUploadedFiles(1)).toHaveLength(1);
  });
});
