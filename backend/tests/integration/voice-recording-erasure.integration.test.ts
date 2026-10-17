import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createPostgresConversationErasureUnitOfWork,
  createWorkspaceConversationDataErasure,
} from "../../src/app/composition/conversationErasure.js";
import { createVoiceRecordingComposition } from "../../src/app/composition/voiceChannel.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { ConversationErasureService } from "../../src/modules/privacy/public.js";
import { VoiceSessionRepository } from "../../src/modules/voiceChannel/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const VENDOR_KEY = "xi-workspace-secret-0123456789";

/**
 * Erasing a conversation or a visitor through the privacy module's erasure also deletes the call
 * recordings the voice vendor keeps for those conversations: read inside the erasure, before the
 * voice sessions go, and deleted at a stand-in vendor once it committed.
 */
describeIntegration("voice recordings in conversation erasure (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const sessions = new VoiceSessionRepository(database.kysely);
  const audit = { record: vi.fn(async () => undefined) };
  const vendorFetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 200 }));
  const recordings = createVoiceRecordingComposition({
    recordings: sessions,
    credentials: { getApiKey: async () => VENDOR_KEY, hasCredentials: async () => true, isEncryptionConfigured: () => true },
    fetch: vendorFetch,
    auditService: audit,
    metricsRegistry: null,
    logger: createLogger("silent"),
  });
  const erasure = new ConversationErasureService({
    unitOfWork: createPostgresConversationErasureUnitOfWork({ db: database.kysely, logger: { warn: vi.fn() } }),
    invalidation: { enqueue: vi.fn() },
    auditLog: {},
    vendorHeldData: recordings.erasure,
  });
  const seededAccountIds: string[] = [];
  let accountId = "";
  let workspaceId = "";
  let agentId = "";

  beforeAll(async () => {
    await runAllTestMigrations(database);
    const account = await new AccountRepository(database.kysely).create({
      name: "Voice erasure",
      email: `voice-erasure-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    accountId = account.id;
    workspaceId = (await new WorkspaceRepository(database.kysely).create(account.id, "Voice erasure workspace")).id;
    agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Support')", [agentId, workspaceId]);
  });

  afterAll(async () => {
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());
    for (const seeded of seededAccountIds) {
      await lifecycle.deleteAccount({ accountId: seeded, auditEvent: { accountId: seeded, eventType: "account.delete", eventStatus: "success", metadata: {} } });
    }
    await database.close().catch(() => undefined);
  });

  /** A call the website embed started, whose page reported the vendor's id, bound to a new conversation. */
  const recordedCall = async (options: { visitorId?: string } = {}) => {
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, source_channel, visitor_id) VALUES ($1, $2, $3, 'voice', $4)",
      [conversationId, workspaceId, agentId, options.visitorId ?? null],
    );
    const session = { workspaceId, agentId, vendor: "elevenlabs", sessionKey: randomUUID() };
    const visitor = { publicSessionId: randomUUID(), visitorKey: null };
    await sessions.register({ session, visitor, expiresAt: new Date(Date.now() + 60_000), vendorAgent: { agentId: "agent_42", region: "eu" } });
    const vendorConversationId = `conv_${randomUUID().replaceAll("-", "")}`;
    await sessions.recordVendorConversation({ workspaceId, agentId, sessionKey: session.sessionKey, publicSessionId: visitor.publicSessionId, vendorConversationId });
    await sessions.bind(session, conversationId);
    return { conversationId, sessionKey: session.sessionKey, vendorConversationId };
  };

  const vendorDeletes = () => vendorFetch.mock.calls
    .filter(([, init]) => init?.method === "DELETE")
    .map(([url]) => (typeof url === "string" ? url : url instanceof URL ? url.href : url.url));
  const deletionEvents = () => (audit.record.mock.calls as unknown as Array<[{ eventType: string; accountId?: string | null; workspaceId?: string | null; metadata?: Record<string, unknown> }]>)
    .map(([event]) => event)
    .filter((event) => event.eventType === "conversation.recording_deleted");
  const sessionRows = (sessionKey: string) => database.query("SELECT 1 FROM voice_sessions WHERE session_key = $1", [sessionKey]);

  describe("erasing one conversation", () => {
    it("deletes its recording at the vendor's region host, audits the deletion, and removes the voice session", async () => {
      vendorFetch.mockClear();
      audit.record.mockClear();
      const erased = await recordedCall();
      const kept = await recordedCall();

      const receipt = await erasure.eraseConversation({ workspaceId, conversationId: erased.conversationId, actor: { accountId, userId: null } });

      expect(receipt.rowsByOwner["voice-channel"]).toBe(1);
      expect(vendorDeletes()).toEqual([`https://api.eu.residency.elevenlabs.io/v1/convai/conversations/${erased.vendorConversationId}`]);
      expect(vendorFetch.mock.calls[0]?.[1]?.headers).toMatchObject({ "xi-api-key": VENDOR_KEY });
      expect(deletionEvents()).toEqual([expect.objectContaining({
        accountId,
        workspaceId,
        metadata: { conversationId: erased.conversationId, vendor: "elevenlabs", outcome: "deleted" },
      })]);
      await expect(sessionRows(erased.sessionKey)).resolves.toEqual([]);
      await expect(sessionRows(kept.sessionKey)).resolves.toHaveLength(1);
    });

    it("still erases the conversation when the vendor refuses to delete the recording", async () => {
      vendorFetch.mockClear();
      audit.record.mockClear();
      vendorFetch.mockResolvedValueOnce(new Response("{}", { status: 500 }));
      const { conversationId } = await recordedCall();

      await erasure.eraseConversation({ workspaceId, conversationId, actor: { accountId, userId: null } });

      await expect(database.query("SELECT 1 FROM conversations WHERE id = $1", [conversationId])).resolves.toEqual([]);
      expect(deletionEvents()).toEqual([]);
    });
  });

  describe("erasing a visitor", () => {
    it("deletes the recording of every conversation the visitor had", async () => {
      vendorFetch.mockClear();
      audit.record.mockClear();
      const [visitor] = await database.query<{ id: string }>(
        "INSERT INTO visitors (workspace_id, visitor_key, conversation_count) VALUES ($1, $2, 0) RETURNING id",
        [workspaceId, `visitor-key-${randomUUID()}`],
      );
      const first = await recordedCall({ visitorId: visitor.id });
      const second = await recordedCall({ visitorId: visitor.id });

      await erasure.eraseVisitor({ workspaceId, visitorId: visitor.id, actor: { accountId, userId: null } });

      expect(vendorDeletes().sort()).toEqual([first.vendorConversationId, second.vendorConversationId]
        .map((id) => `https://api.eu.residency.elevenlabs.io/v1/convai/conversations/${id}`)
        .sort());
      expect(deletionEvents().map((event) => event.metadata?.conversationId).sort()).toEqual([first.conversationId, second.conversationId].sort());
    });
  });
});
