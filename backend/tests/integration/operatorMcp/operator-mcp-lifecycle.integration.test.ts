import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRepository } from "../../../src/db/repositories/sessionRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("operator MCP lifecycle", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const sessions = new SessionRepository(database.kysely);
  const accountId = randomUUID();
  const userId = randomUUID();
  const sessionId = randomUUID();
  const sessionHash = `session-${randomUUID()}`;

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Lifecycle', $2, 'hash')", [accountId, `lifecycle-${accountId}@example.com`]);
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [userId, `lifecycle-user-${userId}@example.com`]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'member', 'active')", [randomUUID(), accountId, userId]);
    await database.query("INSERT INTO sessions (id, account_id, user_id, session_token_hash, expires_at) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 hour')", [sessionId, accountId, userId, sessionHash]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("rejects an otherwise active dashboard session immediately after user disablement", async () => {
    await expect(sessions.findActiveByTokenHash(sessionHash, new Date())).resolves.toMatchObject({ id: sessionId });
    await database.query("UPDATE users SET disabled_at = NOW() WHERE id = $1", [userId]);
    await expect(sessions.findActiveByTokenHash(sessionHash, new Date())).resolves.toBeNull();
    await database.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [userId]);
  });
});
