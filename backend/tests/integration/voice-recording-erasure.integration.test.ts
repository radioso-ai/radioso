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
    { key: { current: randomBytes(32).toString("base64"), previous: [] } },
  );
  const vendorFetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 200 }));
  const jobs = new BackgroundJobRepository(database.kysely);
  const wake = { requestDrain: vi.fn(async () => {}) };
  const queue = new DefaultBackgroundJobQueue({ writer: jobs, wake, logger });
  /** Staff's view: the error reports the job sends for recordings it leaves at the vendor. */
  const errorReporter = { report: vi.fn(async (_input: { errorType: string; metadata?: Record<string, unknown> }) => undefined) };
  const voice = createVoiceRecordingComposition({
    recordings: sessions,
    recordingsIn: (db) => new VoiceSessionRepository(db),
    erasures: new VoiceRecordingErasureRepository(database.kysely),
    erasuresIn: (db) => new VoiceRecordingErasureRepository(db),
    credentials,
    fetch: vendorFetch,
    auditService,
    queue,
    errorReporter,
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
  /** Every live run of an erasure: the one its hand-off queued, and any follow-up queued for a later time. */
  const erasureJobs = (erasureId: string) => database.query<{ id: string; status: string; attempts: number; last_error: string | null; due_in_seconds: number }>(
    `SELECT id, status, attempts, last_error, extract(epoch FROM available_at - now())::int AS due_in_seconds
       FROM background_jobs WHERE kind = $1 AND idempotency_key LIKE $2 AND dead_at IS NULL`,
    [ERASURE_JOB, `${erasureId}%`],
  );
  /** The erasure's waiting recordings and runs, due now rather than after their waits. */
  const makeDue = async (erasureId: string) => {
    await database.query("UPDATE voice_recording_erasure_items SET next_attempt_at = now() WHERE erasure_id = $1 AND status = 'pending'", [erasureId]);
    await database.query(
      "UPDATE background_jobs SET available_at = now() WHERE kind = $1 AND idempotency_key LIKE $2 AND status = 'pending'",
      [ERASURE_JOB, `${erasureId}%`],
    );
  };
  const itemTimes = (erasureId: string) => database.query<{ attempts: number; due_in_seconds: number }>(
    "SELECT attempts, extract(epoch FROM next_attempt_at - now())::int AS due_in_seconds FROM voice_recording_erasure_items WHERE erasure_id = $1 ORDER BY attempts DESC",
    [erasureId],
  );
  const leftAtVendorReports = () => errorReporter.report.mock.calls
    .map(([input]) => input)
    .filter((input) => input.errorType === "voice.recording_left_at_vendor");
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
    errorReporter.report.mockClear();
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
      // The recording waits a minute for its next ask, and the run queued the next for then: no failed run, no burnt attempt.
      const [waiting] = await itemTimes(erasureId);
      expect(waiting.due_in_seconds).toBeGreaterThan(50);
      expect(waiting.due_in_seconds).toBeLessThanOrEqual(60);
      const [followUp] = await erasureJobs(erasureId);
      expect(followUp).toMatchObject({ status: "pending", attempts: 0, last_error: null });
      expect(followUp.due_in_seconds).toBeGreaterThan(50);
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
      // Staff hear of it by ids, counts and codes.
      expect(leftAtVendorReports()).toEqual([expect.objectContaining({
        errorType: "voice.recording_left_at_vendor",
        metadata: { erasureId, accountId: seeded.accountId, vendor: "elevenlabs", leftAtVendor: 1, reasons: { vendor_rejected: 1 } },
      })]);
      expect(JSON.stringify(errorReporter.report.mock.calls)).not.toContain(VENDOR_KEY);
      // The organization reads it in its own list; another organization does not.
      const listed = await new VoiceRecordingErasureRepository(database.kysely).listForAccount({ accountId: seeded.accountId, limit: 10 });
      expect(listed).toEqual({
        total: 1,
        recordings: [{
          vendor: "elevenlabs",
          vendorRegion: "eu",
          vendorConversationId,
          conversationId,
          workspaceId: seeded.workspaceId,
          reason: "vendor_rejected",
          failedAt: expect.any(Date),
        }],
        nextCursor: null,
      });
      const stranger = await seedWorkspace();
      await expect(new VoiceRecordingErasureRepository(database.kysely).listForAccount({ accountId: stranger.accountId, limit: 10 }))
        .resolves.toEqual({ total: 0, recordings: [], nextCursor: null });
    });

    it("asks each recording of an erasure on its own schedule: eight asks over about a day, whatever the others do", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const calls = [await recordedCall(seeded), await recordedCall(seeded), await recordedCall(seeded)];
      const stubborn = calls[0].vendorConversationId;
      // The stubborn recording is refused every time; the others only on their first ask.
      const asked = new Map<string, number>();
      vendorFetch.mockImplementation(async (url) => {
        const id = (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).split("/").at(-1)!;
        asked.set(id, (asked.get(id) ?? 0) + 1);
        return new Response("{}", { status: id === stubborn || asked.get(id) === 1 ? 503 : 200 });
      });
      await lifecycle.deleteWorkspace({
        accountId: seeded.accountId,
        workspaceId: seeded.workspaceId,
        auditEvent: { accountId: seeded.accountId, eventType: "workspace.deleted", eventStatus: "success", metadata: {} },
      });
      const [{ erasure_id: erasureId }] = await heldRecordings(stubborn);

      const waits: number[] = [];
      for (let run = 0; run < 12; run += 1) {
        await worker.drain({ maxJobs: 5 });
        const [held] = await heldRecordings(stubborn);
        if (held?.status !== "pending") break;
        waits.push((await itemTimes(erasureId))[0].due_in_seconds);
        await makeDue(erasureId);
      }

      // The schedule's waits, one per refused ask, then the eighth ask gives up.
      expect(waits.map((wait) => Math.round(wait / 60))).toEqual([1, 5, 15, 60, 180, 360, 720]);
      expect(asked.get(stubborn)).toBe(8);
      for (const call of calls.slice(1)) {
        expect(asked.get(call.vendorConversationId)).toBe(2);
        await expect(heldRecordings(call.vendorConversationId)).resolves.toEqual([]);
      }
      await expect(heldRecordings(stubborn)).resolves.toEqual([expect.objectContaining({ status: "failed", attempts: 8, sealed_api_key: null })]);
    });

    it("stops asking a vendor that answers 429 and waits for its Retry-After, leaving recordings it never asked about uncounted", async () => {
      await reset();
      vendorFetch.mockImplementation(async () => new Response("{}", { status: 429, headers: { "retry-after": "600" } }));
      const seeded = await seedWorkspace();
      for (let call = 0; call < 6; call += 1) await recordedCall(seeded);

      await lifecycle.deleteWorkspace({
        accountId: seeded.accountId,
        workspaceId: seeded.workspaceId,
        auditEvent: { accountId: seeded.accountId, eventType: "workspace.deleted", eventStatus: "success", metadata: {} },
      });
      const [{ id: erasureId }] = await database.query<{ id: string }>("SELECT id FROM voice_recording_erasures WHERE workspace_id = $1", [seeded.workspaceId]);
      await worker.drain({ maxJobs: 1 });

      // At most the four asks already in flight; every recording waits out the vendor's ten minutes, and
      // none of it counts as an ask: the vendor turned the requests away without considering them.
      expect(vendorDeletes().length).toBeLessThanOrEqual(4);
      const times = await itemTimes(erasureId);
      expect(times).toHaveLength(6);
      expect(times.every((time) => time.due_in_seconds > 590 && time.due_in_seconds <= 600)).toBe(true);
      expect(times.every((time) => time.attempts === 0)).toBe(true);
      const [followUp] = await erasureJobs(erasureId);
      expect(followUp.due_in_seconds).toBeGreaterThan(590);
      await database.query("DELETE FROM background_jobs WHERE kind = $1 AND idempotency_key LIKE $2", [ERASURE_JOB, `${erasureId}%`]);
      await database.query("DELETE FROM voice_recording_erasures WHERE id = $1", [erasureId]);
    });

    it("waits at most an hour for a vendor that answers 429 with a longer Retry-After", async () => {
      await reset();
      vendorFetch.mockImplementation(async () => new Response("{}", { status: 429, headers: { "retry-after": "86400" } }));
      const { erasureId } = await (async () => {
        const seeded = await seedWorkspace();
        const call = await recordedCall(seeded);
        await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: call.conversationId!, actor: { accountId: seeded.accountId, userId: null } });
        return { erasureId: (await heldRecordings(call.vendorConversationId))[0].erasure_id };
      })();

      await worker.drain({ maxJobs: 1 });

      const [time] = await itemTimes(erasureId);
      expect(time.due_in_seconds).toBeGreaterThan(3_590);
      expect(time.due_in_seconds).toBeLessThanOrEqual(3_600);
      await database.query("DELETE FROM background_jobs WHERE kind = $1 AND idempotency_key LIKE $2", [ERASURE_JOB, `${erasureId}%`]);
      await database.query("DELETE FROM voice_recording_erasures WHERE id = $1", [erasureId]);
    });

    it("leaves every recording of a workspace that held no vendor key at the vendor in one run, one record each, one report", async () => {
      await reset();
      const seeded = await seedWorkspace({ vendorKey: false });
      // More than one run's claim, so a run per batch of claims would need two.
      await database.query(
        `INSERT INTO voice_sessions (workspace_id, agent_id, vendor, session_key, vendor_agent_id, vendor_region, vendor_conversation_id)
         SELECT $1, $2, 'elevenlabs', 'keyless-' || n, 'agent_42', 'eu', 'conv_keyless_' || $3 || '_' || n FROM generate_series(1, 60) AS n`,
        [seeded.workspaceId, seeded.agentId, randomUUID().replaceAll("-", "")],
      );
      await lifecycle.deleteWorkspace({
        accountId: seeded.accountId,
        workspaceId: seeded.workspaceId,
        auditEvent: { accountId: seeded.accountId, eventType: "workspace.deleted", eventStatus: "success", metadata: {} },
      });

      await worker.drain({ maxJobs: 1 });

      expect(vendorDeletes()).toEqual([]);
      const [{ failed }] = await database.query<{ failed: number }>(
        `SELECT count(*) FILTER (WHERE i.failure_reason = 'credential_missing' AND i.status = 'failed')::int AS failed
           FROM voice_recording_erasure_items i JOIN voice_recording_erasures e ON e.id = i.erasure_id WHERE e.workspace_id = $1`,
        [seeded.workspaceId],
      );
      expect(failed).toBe(60);
      expect((await recordingAudits({ deletedWorkspaceId: seeded.workspaceId })).filter((row) => row.metadata_json.reason === "credential_missing")).toHaveLength(60);
      expect(leftAtVendorReports()).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ leftAtVendor: 60, reasons: { credential_missing: 60 } }) })]);

      // The organization pages through all of them: no recording twice, none skipped, though all failed at the same instant.
      const backlog = new VoiceRecordingErasureRepository(database.kysely);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const listed = await backlog.listForAccount({ accountId: seeded.accountId, limit: 25, ...(cursor ? { cursor } : {}) });
        expect(listed.total).toBe(60);
        seen.push(...listed.recordings.map((recording) => recording.vendorConversationId));
        if (!listed.nextCursor) break;
        cursor = listed.nextCursor;
      }
      expect(seen).toHaveLength(60);
      expect(new Set(seen).size).toBe(60);
    });

    it("leaves a recording still pending a week after its deletion at the vendor, recorded and reported", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const call = await recordedCall(seeded);
      await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: call.conversationId!, actor: { accountId: seeded.accountId, userId: null } });
      const [{ erasure_id: erasureId }] = await heldRecordings(call.vendorConversationId);
      await database.query("UPDATE voice_recording_erasure_items SET created_at = now() - interval '8 days' WHERE erasure_id = $1", [erasureId]);

      await worker.drain({ maxJobs: 10 });

      expect(vendorDeletes()).toEqual([]);
      await expect(heldRecordings(call.vendorConversationId)).resolves.toEqual([expect.objectContaining({ status: "failed", failure_reason: "expired", sealed_api_key: null })]);
      expect((await recordingAudits({ conversationId: call.conversationId })).map((row) => [row.event_status, row.metadata_json.reason])).toEqual([["failure", "expired"]]);
      expect(leftAtVendorReports()).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ reasons: { expired: 1 } }) })]);
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
      // Its claim's lease on the recording has run out too.
      await database.query("UPDATE voice_recording_erasure_items SET attempts = 1, next_attempt_at = now() - interval '1 second' WHERE erasure_id = $1", [erasureId]);
      vendorFetch.mockImplementation(async () => new Response("{}", { status: 404 }));

      await newWorker().drain({ maxJobs: 10 });

      expect((await recordingAudits({ conversationId })).map((row) => row.metadata_json.outcome)).toEqual(["already_absent"]);
      await expect(heldRecordings(vendorConversationId)).resolves.toEqual([]);
      await expect(erasureJobs(erasureId)).resolves.toEqual([]);
    });
  });

  describe("recordings no run can finish", () => {
    /** One conversation erasure's recording, handed off and committed, with its erasure id. */
    const handedOff = async () => {
      const seeded = await seedWorkspace();
      const call = await recordedCall(seeded);
      await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: call.conversationId!, actor: { accountId: seeded.accountId, userId: null } });
      const [{ erasure_id: erasureId }] = await heldRecordings(call.vendorConversationId);
      return { seeded, call, erasureId };
    };

    it("leases what a claim takes, so a run that takes over cannot ask about the same recordings", async () => {
      await reset();
      const { erasureId } = await handedOff();
      const backlog = new VoiceRecordingErasureRepository(database.kysely);

      const claim = { limit: 50, leaseSeconds: 300, expireAfterSeconds: 7 * 24 * 60 * 60 };
      const first = await backlog.claim(erasureId, claim);
      const second = await backlog.claim(erasureId, claim);

      expect(first).toMatchObject({ kind: "batch", items: [expect.objectContaining({ attempts: 1 })] });
      expect(second).toMatchObject({ kind: "batch", items: [] });
      const [time] = await itemTimes(erasureId);
      expect(time.due_in_seconds).toBeGreaterThan(290);
      await database.query("DELETE FROM background_jobs WHERE kind = $1 AND idempotency_key LIKE $2", [ERASURE_JOB, `${erasureId}%`]);
      await database.query("DELETE FROM voice_recording_erasures WHERE id = $1", [erasureId]);
    });

    it("queues a run again for an erasure whose recordings no job is working on", async () => {
      await reset();
      const { call, erasureId } = await handedOff();
      // Its job is gone (a dead letter whose hand-back failed, say) and the recording is long overdue.
      await database.query("DELETE FROM background_jobs WHERE kind = $1 AND idempotency_key LIKE $2", [ERASURE_JOB, `${erasureId}%`]);
      await database.query("UPDATE voice_recording_erasure_items SET next_attempt_at = now() - interval '1 hour' WHERE erasure_id = $1", [erasureId]);

      await voice.erasureRecoveryTask.handle.run();
      await worker.drain({ maxJobs: 10 });

      expect(voice.erasureRecoveryTask.id).toBe("voice-recording-erasure-recovery");
      expect(vendorDeletes()).toEqual([recordingUrl(call.vendorConversationId)]);
      await expect(heldRecordings(call.vendorConversationId)).resolves.toEqual([]);
    });

    it("queues nothing for recordings that are held or less than fifteen minutes overdue", async () => {
      await reset();
      const { erasureId } = await handedOff();
      await database.query("DELETE FROM background_jobs WHERE kind = $1 AND idempotency_key LIKE $2", [ERASURE_JOB, `${erasureId}%`]);

      // Held by a claim (due in the future), then ten minutes overdue: both may still be a live job's work.
      for (const due of ["now() + interval '4 minutes'", "now() - interval '10 minutes'"]) {
        await database.query(`UPDATE voice_recording_erasure_items SET next_attempt_at = ${due} WHERE erasure_id = $1`, [erasureId]);
        await voice.erasureRecoveryTask.handle.run();
        await expect(erasureJobs(erasureId)).resolves.toEqual([]);
      }

      await database.query("UPDATE voice_recording_erasure_items SET next_attempt_at = now() - interval '16 minutes' WHERE erasure_id = $1", [erasureId]);
      await voice.erasureRecoveryTask.handle.run();
      await expect(erasureJobs(erasureId)).resolves.toHaveLength(1);
    });

    it("leaves only the recordings whose asks are spent at the vendor once the job itself keeps crashing, and keeps the rest for the recovery sweep", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const spent = await recordedCall(seeded);
      const fresh = await recordedCall(seeded);
      await lifecycle.deleteWorkspace({
        accountId: seeded.accountId,
        workspaceId: seeded.workspaceId,
        auditEvent: { accountId: seeded.accountId, eventType: "workspace.deleted", eventStatus: "success", metadata: {} },
      });
      const [{ erasure_id: erasureId }] = await heldRecordings(spent.vendorConversationId);
      await database.query("UPDATE voice_recording_erasure_items SET attempts = 8 WHERE vendor_conversation_id = $1", [spent.vendorConversationId]);
      await database.query("UPDATE voice_recording_erasure_items SET attempts = 2 WHERE vendor_conversation_id = $1", [fresh.vendorConversationId]);
      // Every attempt the job has was claimed by a worker that died.
      await database.query(
        `UPDATE background_jobs SET status = 'running', attempts = 5, claim_token = gen_random_uuid(),
                lease_expires_at = now() - interval '1 second'
          WHERE kind = $1 AND idempotency_key = $2`,
        [ERASURE_JOB, erasureId],
      );

      await worker.drain({ maxJobs: 1 });

      expect(vendorDeletes()).toEqual([]);
      await expect(heldRecordings(spent.vendorConversationId)).resolves.toEqual([expect.objectContaining({ status: "failed", failure_reason: "drain_failed" })]);
      const [kept] = await heldRecordings(fresh.vendorConversationId);
      expect(kept).toMatchObject({ status: "pending", attempts: 2 });
      expect(kept.sealed_api_key).toEqual(expect.any(String));
      expect((await recordingAudits({ conversationId: spent.conversationId })).map((row) => [row.event_status, row.metadata_json.reason])).toEqual([["failure", "drain_failed"]]);
      expect(leftAtVendorReports()).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ accountId: seeded.accountId, reasons: { drain_failed: 1 } }) })]);
      await database.query("DELETE FROM background_jobs WHERE kind = $1 AND idempotency_key LIKE $2", [ERASURE_JOB, `${erasureId}%`]);
      await database.query("DELETE FROM voice_recording_erasures WHERE id = $1", [erasureId]);
    });

    it("leaves the recordings of a vendor this build does not know at the vendor, and says so", async () => {
      await reset();
      const { call, erasureId } = await handedOff();
      await database.query("UPDATE voice_recording_erasures SET vendor = 'retired-vendor' WHERE id = $1", [erasureId]);

      await worker.drain({ maxJobs: 10 });

      expect(vendorDeletes()).toEqual([]);
      await expect(heldRecordings(call.vendorConversationId)).resolves.toEqual([expect.objectContaining({ status: "failed", failure_reason: "vendor_unsupported", sealed_api_key: null })]);
      expect(leftAtVendorReports()).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ vendor: "retired-vendor", reasons: { vendor_unsupported: 1 } }) })]);
      await expect(recordingAudits({ conversationId: call.conversationId })).resolves.toEqual([expect.objectContaining({
        event_status: "failure",
        metadata_json: expect.objectContaining({ vendor: "retired-vendor", reason: "vendor_unsupported", vendorConversationId: call.vendorConversationId }),
      })]);
    });

    it("leaves a recording in a region this build has no host for at the vendor, recorded once", async () => {
      await reset();
      const { call, erasureId } = await handedOff();
      await database.query("UPDATE voice_recording_erasure_items SET vendor_region = 'moon' WHERE erasure_id = $1", [erasureId]);

      await worker.drain({ maxJobs: 10 });

      expect(vendorDeletes()).toEqual([]);
      await expect(heldRecordings(call.vendorConversationId)).resolves.toEqual([expect.objectContaining({ status: "failed", failure_reason: "vendor_unsupported" })]);
      expect((await recordingAudits({ conversationId: call.conversationId })).map((row) => [row.event_status, row.metadata_json.reason])).toEqual([["failure", "vendor_unsupported"]]);
      expect(leftAtVendorReports()).toHaveLength(1);
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

    it("hands off a workspace with more recordings than one statement could carry as parameters", async () => {
      await reset();
      const seeded = await seedWorkspace();
      // Postgres takes at most 65,535 parameters per statement; a row-per-parameter insert of these would not fit.
      const recordings = 13_200;
      const batchTag = randomUUID().replaceAll("-", "");
      await database.query(
        `INSERT INTO voice_sessions (workspace_id, agent_id, vendor, session_key, vendor_agent_id, vendor_region, vendor_conversation_id)
         SELECT $1, $2, 'elevenlabs', 'bulk-' || n, 'agent_42', 'eu', 'conv_bulk_' || $3 || '_' || n
           FROM generate_series(1, $4::int) AS n`,
        [seeded.workspaceId, seeded.agentId, batchTag, recordings],
      );

      expect(await lifecycle.deleteWorkspace({
        accountId: seeded.accountId,
        workspaceId: seeded.workspaceId,
        auditEvent: { accountId: seeded.accountId, eventType: "workspace.deleted", eventStatus: "success", metadata: {} },
      })).toBe(true);

      const [held] = await database.query<{ erasure_id: string; count: number }>(
        `SELECT e.id AS erasure_id, count(i.id)::int AS count
           FROM voice_recording_erasures e JOIN voice_recording_erasure_items i ON i.erasure_id = e.id
          WHERE e.workspace_id = $1
          GROUP BY e.id`,
        [seeded.workspaceId],
      );
      expect(held.count).toBe(recordings);
      await expect(erasureJobs(held.erasure_id)).resolves.toHaveLength(1);
      expect(vendorDeletes()).toEqual([]);
      // Too many for the other tests' drains: this one's backlog is dropped here.
      await database.query("DELETE FROM background_jobs WHERE kind = $1 AND idempotency_key LIKE $2", [ERASURE_JOB, `${held.erasure_id}%`]);
      await database.query("DELETE FROM voice_recording_erasures WHERE id = $1", [held.erasure_id]);
    }, 120_000);

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

    it("keeps the proof of erasure when the workspace is deleted while the vendor is being asked", async () => {
      await reset();
      const seeded = await seedWorkspace();
      const { conversationId } = await recordedCall(seeded);
      await erasure.eraseConversation({ workspaceId: seeded.workspaceId, conversationId: conversationId!, actor: { accountId: seeded.accountId, userId: null } });
      vendorFetch.mockImplementation(async () => {
        await lifecycle.deleteWorkspace({
          accountId: seeded.accountId,
          workspaceId: seeded.workspaceId,
          auditEvent: { accountId: seeded.accountId, eventType: "workspace.deleted", eventStatus: "success", metadata: {} },
        });
        return new Response("{}", { status: 200 });
      });

      await worker.drain({ maxJobs: 10 });

      await expect(recordingAudits({ conversationId })).resolves.toEqual([{
        account_id: seeded.accountId,
        workspace_id: null,
        event_status: "success",
        metadata_json: { conversationId, vendor: "elevenlabs", outcome: "deleted", deletedWorkspaceId: seeded.workspaceId },
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
