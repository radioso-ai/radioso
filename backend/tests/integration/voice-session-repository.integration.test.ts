import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

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

  it("forgets the session when its conversation is deleted", async () => {
    const session = { workspaceId, agentId, vendor: "generic", sessionKey: `room_${randomUUID()}` };
    const conversationId = await insertConversation();
    await repository.bind(session, conversationId);

    await database.query("DELETE FROM conversations WHERE id = $1", [conversationId]);

    await expect(repository.findConversationId(session)).resolves.toBeNull();
  });
});
