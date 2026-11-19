import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AudiencePulseHistoryHorizonRepository } from "../../../src/db/repositories/audiencePulseHistoryHorizonRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("AudiencePulseHistoryHorizonRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new AudiencePulseHistoryHorizonRepository(database.kysely);
  const accountId = randomUUID();

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "History Horizon Test", `history-horizon-${accountId}@example.com`, "hash"],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("reads when the workspace was created and how long it keeps conversations", async () => {
    const keepingId = randomUUID();
    const keepingForeverId = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key, created_at, conversation_retention_days)
       VALUES ($1, $3, 'Keeps 45 days', $4, '2026-05-01T00:00:00Z', 45),
              ($2, $3, 'Keeps everything', $5, '2026-06-01T00:00:00Z', NULL)`,
      [keepingId, keepingForeverId, accountId, `horizon-${keepingId}`, `horizon-${keepingForeverId}`],
    );

    await expect(repository.read(keepingId)).resolves.toEqual({
      workspaceCreatedAt: new Date("2026-05-01T00:00:00Z"),
      conversationRetentionDays: 45,
    });
    await expect(repository.read(keepingForeverId)).resolves.toEqual({
      workspaceCreatedAt: new Date("2026-06-01T00:00:00Z"),
      conversationRetentionDays: null,
    });
    await expect(repository.read(randomUUID())).resolves.toBeNull();
  });
});
