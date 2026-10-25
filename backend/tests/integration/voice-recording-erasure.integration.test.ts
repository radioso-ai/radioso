import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createPostgresConversationErasureUnitOfWork,
  createWorkspaceConversationDataErasure,
  defaultConversationDataErasers,
} from "../../src/app/composition/conversationErasure.js";
import { createVoiceRecordingComposition } from "../../src/app/composition/voiceChannel.js";
import { createWorkspaceDeletionHooks } from "../../src/app/composition/workspaceDeletion.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AuditEventRepository } from "../../src/db/repositories/auditEventRepository.js";
import { BackgroundJobRepository } from "../../src/db/repositories/backgroundJobRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { WorkspaceProviderCredentialsRepository } from "../../src/db/repositories/workspaceProviderCredentialsRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AuditService } from "../../src/modules/audit/composition.js";
import { ConversationErasureService } from "../../src/modules/privacy/public.js";
import { WorkspaceProviderCredentialsService } from "../../src/modules/security/credentials/services/workspaceProviderCredentialsService.js";
import { VoiceRecordingErasureRepository, VoiceSessionRepository } from "../../src/modules/voiceChannel/public.js";
import { BackgroundJobRuntime, DefaultBackgroundJobQueue } from "../../src/shared/background-jobs/index.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const VENDOR_KEY = "xi-workspace-secret-0123456789";
const ERASURE_JOB = "voice.recording_erasure";

type Erasers = NonNullable<Parameters<typeof createPostgresConversationErasureUnitOfWork>[0]["conversationErasers"]>;

interface AuditRow {
  account_id: string | null;
  workspace_id: string | null;
  event_status: string;
  metadata_json: Record<string, unknown>;
}

/**
 * Deleting a conversation, a visitor, a workspace or an organization hands each call recording the
 * voice vendor keeps to a backlog, in the deletion's own transaction, with the workspace's vendor
 * key sealed beside it. A background job then asks a stand-in vendor to delete each one, retries
 * what it refuses, and records every outcome.
 */
describeIntegration("voice recording erasure backlog (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const sessions = new VoiceSessionRepository(database.kysely);
  const logger = createLogger("silent");
  const auditService = new AuditService(logger, new AuditEventRepository(database.kysely));
  const credentials = new WorkspaceProviderCredentialsService(
    new WorkspaceProviderCredentialsRepository(database.kysely),
    auditService,
    { key: randomBytes(32).toString("base64") },
  );
  const vendorFetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 200 }));
  const jobs = new BackgroundJobRepository(database.kysely);
  const wake = { requestDrain: vi.fn(async () => {}) };
  const queue = new DefaultBackgroundJobQueue({ writer: jobs, wake, logger });
  const voice = createVoiceRecordingComposition({
    recordings: sessions,
    recordingsIn: (db) => new VoiceSessionRepository(db),
    erasures: new VoiceRecordingErasureRepository(database.kysely),
    erasuresIn: (db) => new VoiceRecordingErasureRepository(db),
    credentials,
    fetch: vendorFetch,
    auditService,
    queue,
    metricsRegistry: null,
    logger,
  });
  /** A worker that runs only the voice erasure job, as a freshly started process would. */
  const newWorker = () => new BackgroundJobRuntime({ store: jobs, handlers: [voice.erasureJobHandler], logger });
  let worker = newWorker();
  const steps: string[] = [];
  /** The production erasure, with the voice hand-off bound to its transaction and each step noted in order. */
  const erasureWith = (conversationErasers: Erasers = defaultConversationDataErasers) => new ConversationErasureService({
    unitOfWork: createPostgresConversationErasureUnitOfWork({
      db: database.kysely,
      logger: { warn: vi.fn() },
      conversationErasers: conversationErasers.map((bind) => (trx) => {
        const eraser = bind(trx);
        return { owner: eraser.owner, erase: async (scope) => {
          steps.push(`erase:${eraser.owner}`);
          return eraser.erase(scope);
        } };
      }),
      vendorHeldData: (trx) => {
        const bound = voice.erasureIn(trx);
        return { handOff: async (input) => {
          steps.push("vendor:hand-off");
          return bound.handOff(input);
        } };
      },
    }),
    invalidation: { enqueue: vi.fn() },
    auditLog: {},
  });
  const erasure = erasureWith();
  const hooks = createWorkspaceDeletionHooks({ queue, vendorHeld: (trx) => voice.erasureIn(trx) });
  const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, hooks.inTransaction, hooks.afterCommit);
  const seededAccountIds: string[] = [];

  beforeAll(async () => {
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    const cleanup = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());
    for (const seeded of seededAccountIds) {
      await cleanup.deleteAccount({ accountId: seeded, auditEvent: { accountId: seeded, eventType: "account.delete", eventStatus: "success", metadata: {} } });
    }
    await database.close().catch(() => undefined);
  });

  /** An organization with a workspace (and another to keep it deletable) holding the vendor key, and an agent. */
  const seedWorkspace = async (options: { vendorKey?: boolean } = {}) => {
    const account = await new AccountRepository(database.kysely).create({
      name: "Voice erasure",
      email: `voice-erasure-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspaces = new WorkspaceRepository(database.kysely);
    const workspaceId = (await workspaces.create(account.id, "Voice erasure workspace")).id;
    const otherWorkspaceId = (await workspaces.create(account.id, "Kept workspace")).id;
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Support')", [agentId, workspaceId]);
    if (options.vendorKey !== false) {
      await credentials.setApiKey({ workspaceId, provider: "elevenlabs", apiKey: VENDOR_KEY, actor: { accountId: account.id } });
    }
    return { accountId: account.id, workspaceId, otherWorkspaceId, agentId };
  };

  /** A visitor of the website embed, with the durable key the embed's sessions carry. */
  const seedVisitor = async (workspaceId: string) => {
    const visitorKey = `visitor-key-${randomUUID()}`;
    const [visitor] = await database.query<{ id: string }>(
      "INSERT INTO visitors (workspace_id, visitor_key, conversation_count) VALUES ($1, $2, 0) RETURNING id",
      [workspaceId, visitorKey],
    );
    return { visitorId: visitor.id, visitorKey };
  };

  /**
   * A call the website embed started, whose page reported the vendor's id; bound to a new
   * conversation (of the visitor, when one is named) unless its first turn never came.
   */
  const recordedCall = async (
    seeded: { workspaceId: string; agentId: string },
    options: { visitor?: { visitorId: string; visitorKey: string }; bound?: boolean } = {},
  ) => {
    const { workspaceId, agentId } = seeded;
    const session = { workspaceId, agentId, vendor: "elevenlabs", sessionKey: randomUUID() };
    const visitor = { publicSessionId: randomUUID(), visitorKey: options.visitor?.visitorKey ?? null };
    await sessions.register({ session, visitor, expiresAt: new Date(Date.now() + 60_000), vendorAgent: { agentId: "agent_42", region: "eu" } });
    const vendorConversationId = `conv_${randomUUID().replaceAll("-", "")}`;
    await sessions.recordVendorConversation({ workspaceId, agentId, sessionKey: session.sessionKey, publicSessionId: visitor.publicSessionId, vendorConversationId });
    if (options.bound === false) return { conversationId: null, sessionKey: session.sessionKey, vendorConversationId };
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, source_channel, visitor_id) VALUES ($1, $2, $3, 'voice', $4)",
      [conversationId, workspaceId, agentId, options.visitor?.visitorId ?? null],
    );
    await sessions.bind(session, conversationId);
    return { conversationId, sessionKey: session.sessionKey, vendorConversationId };
  };

  const recordingUrl = (vendorConversationId: string) =>
    `https://api.eu.residency.elevenlabs.io/v1/convai/conversations/${vendorConversationId}`;
  const vendorDeletes = () => vendorFetch.mock.calls
    .filter(([, init]) => init?.method === "DELETE")
    .map(([url]) => (typeof url === "string" ? url : url instanceof URL ? url.href : url.url));
  const sessionRows = (sessionKey: string) => database.query("SELECT 1 FROM voice_sessions WHERE session_key = $1", [sessionKey]);
  const heldRecordings = (vendorConversationId: string) => database.query<{
    erasure_id: string;
    account_id: string;
    workspace_id: string;
    conversation_id: string | null;
    vendor: string;
    vendor_region: string;
    status: string;
    attempts: number;
    failure_reason: string | null;
    sealed_api_key: string | null;
  }>(
    `SELECT i.erasure_id, e.account_id, e.workspace_id, i.conversation_id, e.vendor, i.vendor_region, i.status, i.attempts,
            i.failure_reason, e.sealed_api_key
       FROM voice_recording_erasure_items i JOIN voice_recording_erasures e ON e.id = i.erasure_id
      WHERE i.vendor_conversation_id = $1`,
    [vendorConversationId],
  );
  const erasureRows = (erasureId: string) => database.query<{ sealed_api_key: string | null }>(
    "SELECT sealed_api_key FROM voice_recording_erasures WHERE id = $1",
    [erasureId],
  );
  const erasureJobs = (erasureId: string) => database.query<{ id: string; status: string; attempts: number; last_error: string | null }>(
    "SELECT id, status, attempts, last_error FROM background_jobs WHERE kind = $1 AND idempotency_key = $2 AND dead_at IS NULL",
    [ERASURE_JOB, erasureId],
  );
  /** A retried job, due again now rather than after its backoff. */
  const makeDue = (erasureId: string) => database.query(
    "UPDATE background_jobs SET available_at = now() WHERE kind = $1 AND idempotency_key = $2 AND status = 'pending'",
    [ERASURE_JOB, erasureId],
  );
  const recordingAudits = async (match: { conversationId?: string | null; vendorConversationId?: string; deletedWorkspaceId?: string }) => {
    const rows = await database.query<AuditRow>(
      "SELECT account_id, workspace_id, event_status, metadata_json FROM audit_events WHERE event_type = 'conversation.recording_deleted' ORDER BY created_at",
    );
    return rows.filter((row) => Object.entries(match).every(([key, value]) => row.metadata_json[key] === value));
  };

  /** Drains what an earlier test left due, then forgets every call. */
  const reset = async () => {
    vendorFetch.mockImplementation(async () => new Response("{}", { status: 200 }));
    await worker.drain({ maxJobs: 50 });
    vendorFetch.mockClear();
    wake.requestDrain.mockClear();
    steps.length = 0;
  };

  describe("erasing one conversation", () => {
    it("hands its recording to the backlog with the key sealed, in the erasure's transaction, and asks the vendor nothing yet", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const erased = await recordedCall(seeded);
      const kept = await recordedCall(seeded);

      const receipt = await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: erased.conversationId!, actor: { accountId: seeded.accountId, userId: null } });

      // The hand-off comes first: the voice eraser among the others removes the row that names the recording.
      expect(steps[0]).toBe("vendor:hand-off");
      expect(receipt.rowsByOwner["voice-channel"]).toBe(1);
      expect(vendorDeletes()).toEqual([]);
      const [held] = await heldRecordings(erased.vendorConversationId);
      expect(held).toMatchObject({
        account_id: seeded.accountId,
        workspace_id: seeded.workspaceId,
        conversation_id: erased.conversationId,
        vendor: "elevenlabs",
        vendor_region: "eu",
        status: "pending",
        attempts: 0,
        failure_reason: null,
      });
      expect(held.sealed_api_key).toEqual(expect.any(String));
      expect(held.sealed_api_key).not.toContain(VENDOR_KEY);
      await expect(erasureJobs(held.erasure_id)).resolves.toEqual([expect.objectContaining({ status: "pending" })]);
      expect(wake.requestDrain).toHaveBeenCalled();
      await expect(sessionRows(erased.sessionKey)).resolves.toEqual([]);
      await expect(sessionRows(kept.sessionKey)).resolves.toHaveLength(1);
      await expect(heldRecordings(kept.vendorConversationId)).resolves.toEqual([]);
    });

    it("deletes the recording at the vendor's region host with the held key, audits it, and drops the key and the backlog", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const erased = await recordedCall(seeded);
      await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: erased.conversationId!, actor: { accountId: seeded.accountId, userId: null } });
      const [{ erasure_id: erasureId }] = await heldRecordings(erased.vendorConversationId);

      await worker.drain({ maxJobs: 10 });

      expect(vendorDeletes()).toEqual([recordingUrl(erased.vendorConversationId)]);
      expect(vendorFetch.mock.calls[0]?.[1]?.headers).toMatchObject({ "xi-api-key": VENDOR_KEY });
      await expect(recordingAudits({ conversationId: erased.conversationId })).resolves.toEqual([{
        account_id: seeded.accountId,
        workspace_id: seeded.workspaceId,
        event_status: "success",
        metadata_json: { conversationId: erased.conversationId, vendor: "elevenlabs", outcome: "deleted" },
      }]);
      await expect(heldRecordings(erased.vendorConversationId)).resolves.toEqual([]);
      await expect(erasureRows(erasureId)).resolves.toEqual([]);
      await expect(erasureJobs(erasureId)).resolves.toEqual([]);
    });

    it("counts a recording the vendor no longer held as done, and audits it as already absent", async () => {
      await reset();
      vendorFetch.mockImplementation(async () => new Response("{}", { status: 404 }));
      const seeded = await seedWorkspace();
      const { conversationId, vendorConversationId } = await recordedCall(seeded);

      await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: conversationId!, actor: { accountId: seeded.accountId, userId: null } });
      await worker.drain({ maxJobs: 10 });

      expect((await recordingAudits({ conversationId })).map((row) => row.metadata_json.outcome)).toEqual(["already_absent"]);
      await expect(heldRecordings(vendorConversationId)).resolves.toEqual([]);
    });

    it("hands off nothing, and keeps the conversation and its voice session, when an eraser fails after the hand-off", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const { conversationId, sessionKey, vendorConversationId } = await recordedCall(seeded);
      const failing = erasureWith([...defaultConversationDataErasers, () => ({ owner: "failing", erase: async () => { throw new Error("eraser failed"); } })]);
      const erasureJobCount = async () => (await database.query("SELECT 1 FROM background_jobs WHERE kind = $1", [ERASURE_JOB])).length;
      const jobsBefore = await erasureJobCount();

      await expect(failing.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: conversationId!, actor: { accountId: seeded.accountId, userId: null } })).rejects.toThrow("eraser failed");

      expect(steps[0]).toBe("vendor:hand-off");
      await expect(heldRecordings(vendorConversationId)).resolves.toEqual([]);
      await expect(erasureJobCount()).resolves.toBe(jobsBefore);
      expect(wake.requestDrain).not.toHaveBeenCalled();
      await expect(database.query("SELECT 1 FROM conversations WHERE id = $1", [conversationId])).resolves.toHaveLength(1);
      await expect(sessionRows(sessionKey)).resolves.toHaveLength(1);
    });
  });

  describe("a vendor that does not delete", () => {
    it("is asked again with backoff, and a later ask that succeeds deletes the recording", async () => {
      await reset();
      vendorFetch.mockResolvedValueOnce(new Response("{}", { status: 500 }));
      const seeded = await seedWorkspace();
      const { conversationId, vendorConversationId } = await recordedCall(seeded);
      await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: conversationId!, actor: { accountId: seeded.accountId, userId: null } });
      const [{ erasure_id: erasureId }] = await heldRecordings(vendorConversationId);

      await worker.drain({ maxJobs: 10 });

      await expect(heldRecordings(vendorConversationId)).resolves.toEqual([expect.objectContaining({ status: "pending", attempts: 1, failure_reason: "vendor_rejected" })]);
      const [retrying] = await erasureJobs(erasureId);
      expect(retrying).toMatchObject({ status: "pending", attempts: 1 });
      expect(retrying.last_error).toBeTruthy();
      await expect(database.query("SELECT 1 FROM conversations WHERE id = $1", [conversationId])).resolves.toEqual([]);

      await makeDue(erasureId);
      await worker.drain({ maxJobs: 10 });

      expect(vendorDeletes()).toEqual([recordingUrl(vendorConversationId), recordingUrl(vendorConversationId)]);
      expect((await recordingAudits({ conversationId })).map((row) => row.metadata_json.outcome)).toEqual(["deleted"]);
      await expect(heldRecordings(vendorConversationId)).resolves.toEqual([]);
      await expect(erasureRows(erasureId)).resolves.toEqual([]);
    });

    it("leaves the recording as failed once its asks run out, records why, and drops the key", async () => {
      await reset();
      vendorFetch.mockImplementation(async () => new Response("{}", { status: 503 }));
      const seeded = await seedWorkspace();
      const { conversationId, vendorConversationId } = await recordedCall(seeded);
      await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: conversationId!, actor: { accountId: seeded.accountId, userId: null } });
      const [{ erasure_id: erasureId }] = await heldRecordings(vendorConversationId);

      for (let run = 0; run < 12 && (await erasureJobs(erasureId)).length > 0; run += 1) {
        await makeDue(erasureId);
        await worker.drain({ maxJobs: 10 });
      }

      expect(vendorDeletes()).toHaveLength(8);
      await expect(heldRecordings(vendorConversationId)).resolves.toEqual([expect.objectContaining({
        status: "failed",
        attempts: 8,
        failure_reason: "vendor_rejected",
        sealed_api_key: null,
      })]);
      await expect(erasureJobs(erasureId)).resolves.toEqual([]);
      await expect(recordingAudits({ conversationId })).resolves.toEqual([{
        account_id: seeded.accountId,
        workspace_id: seeded.workspaceId,
        event_status: "failure",
        metadata_json: { conversationId, vendor: "elevenlabs", outcome: "left_at_vendor", reason: "vendor_rejected", vendorConversationId },
      }]);
    });

    it("records a recording whose workspace held no vendor key as left at the vendor, without asking", async () => {
      await reset();
      const seeded = await seedWorkspace({ vendorKey: false });
      const { conversationId, vendorConversationId } = await recordedCall(seeded);

      await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: conversationId!, actor: { accountId: seeded.accountId, userId: null } });
      await worker.drain({ maxJobs: 10 });

      expect(vendorDeletes()).toEqual([]);
      await expect(heldRecordings(vendorConversationId)).resolves.toEqual([expect.objectContaining({ status: "failed", failure_reason: "credential_missing", sealed_api_key: null })]);
      expect((await recordingAudits({ conversationId })).map((row) => [row.event_status, row.metadata_json.reason])).toEqual([["failure", "credential_missing"]]);
    });
  });

  describe("a worker that stops between the commit and the vendor", () => {
    it("leaves a backlog the next worker drains, when no run followed the commit", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const { conversationId, vendorConversationId } = await recordedCall(seeded);
      await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: conversationId!, actor: { accountId: seeded.accountId, userId: null } });

      // The process that committed is gone before any job ran; a new one starts.
      worker = newWorker();
      await worker.drain({ maxJobs: 10 });

      expect(vendorDeletes()).toEqual([recordingUrl(vendorConversationId)]);
      expect((await recordingAudits({ conversationId })).map((row) => row.metadata_json.outcome)).toEqual(["deleted"]);
      await expect(heldRecordings(vendorConversationId)).resolves.toEqual([]);
    });

    it("asks again after a run that died between the vendor's delete and its own record, and counts the absent recording as done", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const { conversationId, vendorConversationId } = await recordedCall(seeded);
      await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: conversationId!, actor: { accountId: seeded.accountId, userId: null } });
      const [{ erasure_id: erasureId }] = await heldRecordings(vendorConversationId);
      // A worker claimed the job and the recording, the vendor deleted it, and the worker died before writing anything back.
      await database.query(
        `UPDATE background_jobs SET status = 'running', attempts = 1, claim_token = gen_random_uuid(),
                lease_expires_at = now() - interval '1 second'
          WHERE kind = $1 AND idempotency_key = $2`,
        [ERASURE_JOB, erasureId],
      );
      await database.query("UPDATE voice_recording_erasure_items SET attempts = 1 WHERE erasure_id = $1", [erasureId]);
      vendorFetch.mockImplementation(async () => new Response("{}", { status: 404 }));

      await newWorker().drain({ maxJobs: 10 });

      expect((await recordingAudits({ conversationId })).map((row) => row.metadata_json.outcome)).toEqual(["already_absent"]);
      await expect(heldRecordings(vendorConversationId)).resolves.toEqual([]);
      await expect(erasureJobs(erasureId)).resolves.toEqual([]);
    });
  });

  describe("erasing a visitor", () => {
    it("deletes the recording of every call the visitor had, a call whose first turn never came included", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const visitor = await seedVisitor(seeded.workspaceId);
      const bound = await recordedCall(seeded, { visitor });
      const unanswered = await recordedCall(seeded, { visitor, bound: false });
      const someoneElse = await recordedCall(seeded, { visitor: await seedVisitor(seeded.workspaceId), bound: false });

      const receipt = await erasure.eraseVisitor({ workspaceId: seeded.workspaceId, visitorId: visitor.visitorId, actor: { accountId: seeded.accountId, userId: null } });
      await worker.drain({ maxJobs: 10 });

      expect(steps[0]).toBe("vendor:hand-off");
      expect(vendorDeletes().sort()).toEqual([recordingUrl(bound.vendorConversationId), recordingUrl(unanswered.vendorConversationId)].sort());
      expect((await recordingAudits({ conversationId: bound.conversationId })).map((row) => row.metadata_json.outcome)).toEqual(["deleted"]);
      await expect(sessionRows(bound.sessionKey)).resolves.toEqual([]);
      await expect(sessionRows(unanswered.sessionKey)).resolves.toEqual([]);
      await expect(sessionRows(someoneElse.sessionKey)).resolves.toHaveLength(1);
      expect(receipt.rowsByOwner["voice-channel"]).toBe(2);
    });
  });

  describe("deleting a workspace or an organization", () => {
    it("hands every recording in the workspace to a backlog that outlives the workspace's cascade, its key included", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const call = await recordedCall(seeded);
      const unanswered = await recordedCall(seeded, { bound: false });

      expect(await lifecycle.deleteWorkspace({
        accountId: seeded.accountId,
        workspaceId: seeded.workspaceId,
        auditEvent: { accountId: seeded.accountId, eventType: "workspace.deleted", eventStatus: "success", metadata: {} },
      })).toBe(true);

      expect(vendorDeletes()).toEqual([]);
      expect(wake.requestDrain).toHaveBeenCalled();
      await expect(database.query("SELECT 1 FROM workspaces WHERE id = $1", [seeded.workspaceId])).resolves.toEqual([]);
      await expect(database.query("SELECT 1 FROM workspace_provider_credentials WHERE workspace_id = $1", [seeded.workspaceId])).resolves.toEqual([]);
      await expect(sessionRows(call.sessionKey)).resolves.toEqual([]);
      const held = [...await heldRecordings(call.vendorConversationId), ...await heldRecordings(unanswered.vendorConversationId)];
      expect(held).toEqual([
        expect.objectContaining({ workspace_id: seeded.workspaceId, conversation_id: call.conversationId, status: "pending" }),
        expect.objectContaining({ workspace_id: seeded.workspaceId, conversation_id: null, status: "pending" }),
      ]);
      expect(held[0].sealed_api_key).toEqual(expect.any(String));

      await worker.drain({ maxJobs: 10 });

      expect(vendorDeletes().sort()).toEqual([recordingUrl(call.vendorConversationId), recordingUrl(unanswered.vendorConversationId)].sort());
      expect(vendorFetch.mock.calls.every(([, init]) => (init?.headers as Record<string, string>)["xi-api-key"] === VENDOR_KEY)).toBe(true);
      // The workspace is gone, so its organization keeps the record, naming the workspace by id.
      await expect(recordingAudits({ deletedWorkspaceId: seeded.workspaceId })).resolves.toEqual([
        expect.objectContaining({ account_id: seeded.accountId, workspace_id: null, event_status: "success" }),
        expect.objectContaining({ account_id: seeded.accountId, workspace_id: null, event_status: "success" }),
      ]);
      await expect(heldRecordings(call.vendorConversationId)).resolves.toEqual([]);
      await expect(heldRecordings(unanswered.vendorConversationId)).resolves.toEqual([]);
    });

    it("names the organization by id once it is deleted with its workspaces", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const call = await recordedCall(seeded);

      expect(await lifecycle.deleteAccount({
        accountId: seeded.accountId,
        auditEvent: { accountId: seeded.accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
      })).toBe(true);
      await worker.drain({ maxJobs: 10 });

      expect(vendorDeletes()).toEqual([recordingUrl(call.vendorConversationId)]);
      await expect(recordingAudits({ conversationId: call.conversationId })).resolves.toEqual([{
        account_id: null,
        workspace_id: null,
        event_status: "success",
        metadata_json: {
          conversationId: call.conversationId,
          vendor: "elevenlabs",
          outcome: "deleted",
          deletedWorkspaceId: seeded.workspaceId,
          deletedAccountId: seeded.accountId,
        },
      }]);
    });

    it("keeps a conversation erasure's backlog through a workspace deletion that comes before the job runs", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const { conversationId, vendorConversationId } = await recordedCall(seeded);
      await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: conversationId!, actor: { accountId: seeded.accountId, userId: null } });

      await lifecycle.deleteWorkspace({
        accountId: seeded.accountId,
        workspaceId: seeded.workspaceId,
        auditEvent: { accountId: seeded.accountId, eventType: "workspace.deleted", eventStatus: "success", metadata: {} },
      });
      await expect(heldRecordings(vendorConversationId)).resolves.toEqual([expect.objectContaining({ status: "pending" })]);

      await worker.drain({ maxJobs: 10 });

      expect(vendorDeletes()).toEqual([recordingUrl(vendorConversationId)]);
      await expect(recordingAudits({ conversationId })).resolves.toEqual([
        expect.objectContaining({ account_id: seeded.accountId, workspace_id: null, metadata_json: expect.objectContaining({ deletedWorkspaceId: seeded.workspaceId }) }),
      ]);
    });
  });
});
