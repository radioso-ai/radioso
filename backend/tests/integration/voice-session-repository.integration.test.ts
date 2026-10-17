import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VoiceSessionRepository } from "../../src/modules/voiceChannel/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("VoiceSessionRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new VoiceSessionRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();

  const insertConversation = async (conversationAgentId = agentId): Promise<string> => {
    const conversationId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, source_channel) VALUES ($1, $2, $3, 'voice')",
      [conversationId, workspaceId, conversationAgentId],
    );
    return conversationId;
  };

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Voice Session Test Co", `voice-session-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Voice Session Workspace", `voice-session-${workspaceId}`],
    );
    await database.query(
      "INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3), ($4, $2, $5)",
      [agentId, workspaceId, "Voice Agent", otherAgentId, "Other Voice Agent"],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("binds a session once and keeps the first conversation when a concurrent first turn binds another", async () => {
    const session = { workspaceId, agentId, vendor: "elevenlabs", sessionKey: `conv_${randomUUID()}` };
    await expect(repository.findConversationId(session)).resolves.toBeNull();

    const first = await insertConversation();
    const second = await insertConversation();
    const bound = await Promise.all([repository.bind(session, first), repository.bind(session, second)]);

    expect(new Set(bound).size).toBe(1);
    expect([first, second]).toContain(bound[0]);
    await expect(repository.findConversationId(session)).resolves.toBe(bound[0]);
    await expect(repository.bind(session, await insertConversation())).resolves.toBe(bound[0]);
    const rows = await database.query(
      "SELECT conversation_id FROM voice_sessions WHERE agent_id = $1 AND vendor = $2 AND session_key = $3",
      [agentId, session.vendor, session.sessionKey],
    );
    expect(rows).toEqual([{ conversation_id: bound[0] }]);
  });

  it("scopes a session key to its agent, vendor and workspace", async () => {
    const sessionKey = `shared_${randomUUID()}`;
    const elevenlabs = { workspaceId, agentId, vendor: "elevenlabs", sessionKey };
    const conversationId = await insertConversation();
    await repository.bind(elevenlabs, conversationId);

    await expect(repository.findConversationId({ ...elevenlabs, vendor: "generic" })).resolves.toBeNull();
    await expect(repository.findConversationId({ ...elevenlabs, agentId: otherAgentId })).resolves.toBeNull();
    await expect(repository.findConversationId({ ...elevenlabs, workspaceId: randomUUID() })).resolves.toBeNull();
  });

  it("holds a started session for its first turn, which binds the conversation onto it", async () => {
    const session = { workspaceId, agentId, vendor: "elevenlabs", sessionKey: randomUUID() };
    const visitor = { publicSessionId: randomUUID(), visitorKey: randomUUID() };
    await repository.register({ session, visitor, expiresAt: new Date(Date.now() + 60_000), vendorAgent: { agentId: "agent_42", region: "us" } });

    await expect(repository.findConversationId(session)).resolves.toBeNull();
    await expect(repository.findStartedVisitor(session)).resolves.toEqual(visitor);

    const conversationId = await insertConversation();
    await expect(repository.bind(session, conversationId)).resolves.toBe(conversationId);
    await expect(repository.bind(session, await insertConversation())).resolves.toBe(conversationId);
    await expect(repository.findConversationId(session)).resolves.toBe(conversationId);
    // Once bound, the session has its conversation, and the start is no longer waiting for a turn.
    await expect(repository.findStartedVisitor(session)).resolves.toBeNull();
  });

  it("forgets a start whose first turn never came, and clears it out on the agent's next start", async () => {
    const expired = { workspaceId, agentId, vendor: "elevenlabs", sessionKey: randomUUID() };
    await repository.register({ session: expired, visitor: { publicSessionId: randomUUID(), visitorKey: null }, expiresAt: new Date(Date.now() - 1_000), vendorAgent: { agentId: "agent_42", region: "us" } });

    await expect(repository.findStartedVisitor(expired)).resolves.toBeNull();

    await repository.register({
      session: { ...expired, sessionKey: randomUUID() },
      visitor: { publicSessionId: randomUUID(), visitorKey: null },
      expiresAt: new Date(Date.now() + 60_000),
      vendorAgent: { agentId: "agent_42", region: "us" },
    });
    const rows = await database.query("SELECT 1 FROM voice_sessions WHERE agent_id = $1 AND session_key = $2", [agentId, expired.sessionKey]);
    expect(rows).toEqual([]);
  });

  it("does not let another agent's turn read a start", async () => {
    const session = { workspaceId, agentId, vendor: "elevenlabs", sessionKey: randomUUID() };
    await repository.register({ session, visitor: { publicSessionId: randomUUID(), visitorKey: null }, expiresAt: new Date(Date.now() + 60_000), vendorAgent: { agentId: "agent_42", region: "us" } });

    await expect(repository.findStartedVisitor({ ...session, agentId: otherAgentId })).resolves.toBeNull();
    await expect(repository.findStartedVisitor({ ...session, workspaceId: randomUUID() })).resolves.toBeNull();
  });

  it("forgets the session when its conversation is deleted", async () => {
    const session = { workspaceId, agentId, vendor: "generic", sessionKey: `room_${randomUUID()}` };
    const conversationId = await insertConversation();
    await repository.bind(session, conversationId);

    await database.query("DELETE FROM conversations WHERE id = $1", [conversationId]);

    await expect(repository.findConversationId(session)).resolves.toBeNull();
  });

  describe("recordings", () => {
    const startedSession = async (options: { region?: "us" | "eu"; expiresAt?: Date } = {}) => {
      const session = { workspaceId, agentId, vendor: "elevenlabs", sessionKey: randomUUID() };
      const visitor = { publicSessionId: randomUUID(), visitorKey: null };
      await repository.register({
        session,
        visitor,
        expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000),
        vendorAgent: { agentId: "agent_42", region: options.region ?? "eu" },
      });
      const report = (vendorConversationId: string, overrides: { publicSessionId?: string; agentId?: string; workspaceId?: string } = {}) =>
        repository.recordVendorConversation({
          workspaceId: overrides.workspaceId ?? workspaceId,
          agentId: overrides.agentId ?? agentId,
          sessionKey: session.sessionKey,
          publicSessionId: overrides.publicSessionId ?? visitor.publicSessionId,
          vendorConversationId,
        });
      return { session, visitor, report };
    };

    it("stores the vendor's conversation id once, for the public session the start was for, and finds the recording by conversation", async () => {
      const { session, report } = await startedSession();
      const vendorConversationId = `conv_${randomUUID().replaceAll("-", "")}`;

      await expect(report(vendorConversationId)).resolves.toBe(true);
      await expect(report(`conv_${randomUUID().replaceAll("-", "")}`)).resolves.toBe(false);

      const conversationId = await insertConversation();
      await repository.bind(session, conversationId);
      await expect(repository.findRecording({ workspaceId, conversationId })).resolves.toEqual({
        conversationId,
        vendor: "elevenlabs",
        region: "eu",
        vendorConversationId,
      });
      await expect(repository.findRecording({ workspaceId: randomUUID(), conversationId })).resolves.toBeNull();
    });

    it("takes an id reported after the first turn bound the session", async () => {
      const { session, report } = await startedSession();
      const conversationId = await insertConversation();
      await repository.bind(session, conversationId);

      await expect(report("conv_after_bind")).resolves.toBe(true);
      await expect(repository.findRecording({ workspaceId, conversationId })).resolves.toMatchObject({ vendorConversationId: "conv_after_bind" });
    });

    it("refuses a report from another public session, agent or workspace, and one past the start's expiry", async () => {
      const { report } = await startedSession();
      await expect(report("conv_other_session", { publicSessionId: randomUUID() })).resolves.toBe(false);
      await expect(report("conv_other_agent", { agentId: otherAgentId })).resolves.toBe(false);
      await expect(report("conv_other_workspace", { workspaceId: randomUUID() })).resolves.toBe(false);

      const expired = await startedSession({ expiresAt: new Date(Date.now() - 1_000) });
      await expect(expired.report("conv_expired")).resolves.toBe(false);
    });

    it("refuses a vendor conversation id another session already holds", async () => {
      const first = await startedSession();
      const second = await startedSession();
      const vendorConversationId = `conv_${randomUUID().replaceAll("-", "")}`;

      await expect(first.report(vendorConversationId)).resolves.toBe(true);
      await expect(second.report(vendorConversationId)).resolves.toBe(false);
    });

    it("names the vendor agent and region a report is checked against, while the session waits for one", async () => {
      const { session, visitor, report } = await startedSession({ region: "eu" });
      const waiting = { workspaceId, agentId, sessionKey: session.sessionKey, publicSessionId: visitor.publicSessionId };

      await expect(repository.findReportableSession(waiting)).resolves.toEqual({
        vendor: "elevenlabs",
        vendorAgent: { agentId: "agent_42", region: "eu" },
      });
      await expect(repository.findReportableSession({ ...waiting, publicSessionId: randomUUID() })).resolves.toBeNull();

      await report(`conv_${randomUUID().replaceAll("-", "")}`);
      await expect(repository.findReportableSession(waiting)).resolves.toBeNull();
    });

    it("keeps a reported recording's session through the agent's deletion, and still finds and lists it", async () => {
      const doomedAgentId = randomUUID();
      await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [doomedAgentId, workspaceId, "Deleted Voice Agent"]);
      const session = { workspaceId, agentId: doomedAgentId, vendor: "elevenlabs", sessionKey: randomUUID() };
      const visitor = { publicSessionId: randomUUID(), visitorKey: null };
      await repository.register({ session, visitor, expiresAt: new Date(Date.now() + 60_000), vendorAgent: { agentId: "agent_42", region: "eu" } });
      const vendorConversationId = `conv_${randomUUID().replaceAll("-", "")}`;
      await repository.recordVendorConversation({ workspaceId, agentId: doomedAgentId, sessionKey: session.sessionKey, publicSessionId: visitor.publicSessionId, vendorConversationId });
      const conversationId = await insertConversation(doomedAgentId);
      await repository.bind(session, conversationId);

      await database.query("DELETE FROM agents WHERE id = $1", [doomedAgentId]);

      await expect(repository.findRecording({ workspaceId, conversationId })).resolves.toMatchObject({ vendorConversationId });
      const listed = await repository.listRecordings({ kind: "workspace", workspaceId });
      expect(listed.map((recording) => recording.vendorConversationId)).toContain(vendorConversationId);
    });

    it("keeps an expired start whose page reported a recording when the agent's next start clears the others out", async () => {
      const reported = await startedSession({ expiresAt: new Date(Date.now() + 60_000) });
      const vendorConversationId = `conv_${randomUUID().replaceAll("-", "")}`;
      await reported.report(vendorConversationId);
      await database.query("UPDATE voice_sessions SET start_expires_at = now() - interval '1 minute' WHERE session_key = $1", [reported.session.sessionKey]);
      const abandoned = await startedSession({ expiresAt: new Date(Date.now() - 1_000) });

      await startedSession();

      const kept = await database.query<{ session_key: string }>(
        "SELECT session_key FROM voice_sessions WHERE session_key = ANY($1::text[])",
        [[reported.session.sessionKey, abandoned.session.sessionKey]],
      );
      expect(kept.map((row) => row.session_key)).toEqual([reported.session.sessionKey]);
    });

    it("lists a workspace's recording whose call never bound a conversation, with no conversation", async () => {
      const { report } = await startedSession();
      const vendorConversationId = `conv_${randomUUID().replaceAll("-", "")}`;
      await report(vendorConversationId);

      const listed = await repository.listRecordings({ kind: "workspace", workspaceId });

      expect(listed).toContainEqual({ workspaceId, conversationId: null, vendor: "elevenlabs", region: "eu", vendorConversationId });
    });

    it("has no recording for a session a page started on its own", async () => {
      const session = { workspaceId, agentId, vendor: "elevenlabs", sessionKey: randomUUID() };
      const conversationId = await insertConversation();
      await repository.bind(session, conversationId);

      await expect(repository.findRecording({ workspaceId, conversationId })).resolves.toBeNull();
    });

    it("lists the recordings of some conversations, or of the whole workspace", async () => {
      const bound = await Promise.all([startedSession(), startedSession()].map(async (pending) => {
        const { session, report } = await pending;
        const vendorConversationId = `conv_${randomUUID().replaceAll("-", "")}`;
        await report(vendorConversationId);
        const conversationId = await insertConversation();
        await repository.bind(session, conversationId);
        return { conversationId, vendorConversationId };
      }));

      const some = await repository.listRecordings({ kind: "conversations", workspaceId, conversationIds: [bound[0].conversationId] });
      expect(some.map((recording) => recording.vendorConversationId)).toEqual([bound[0].vendorConversationId]);
      const all = await repository.listRecordings({ kind: "workspace", workspaceId });
      expect(all.map((recording) => recording.vendorConversationId)).toEqual(expect.arrayContaining(bound.map((entry) => entry.vendorConversationId)));
      await expect(repository.listRecordings({ kind: "conversations", workspaceId, conversationIds: [] })).resolves.toEqual([]);
    });
  });
});
