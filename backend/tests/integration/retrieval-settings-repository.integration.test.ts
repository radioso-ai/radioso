import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { RetrievalSettingsRepository } from "../../src/db/repositories/retrievalSettingsRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("RetrievalSettingsRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new RetrievalSettingsRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Retr Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Retr Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(`DELETE FROM retrieval_settings WHERE workspace_id = $1`, [workspaceId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("ensureRow is idempotent and findByWorkspace starts empty", async () => {
    await repository.ensureRow(workspaceId);
    await repository.ensureRow(workspaceId);
    expect(await repository.findByWorkspace(workspaceId)).toEqual([]);
  });

  it("setPreference sets and clears a capability pair", async () => {
    await repository.setPreference(workspaceId, "chat", { provider: "openai", model: "gpt-5.2" });
    const afterSet = await repository.findByWorkspace(workspaceId);
    expect(afterSet).toEqual([
      expect.objectContaining({ capability: "chat", provider: "openai", model: "gpt-5.2" }),
    ]);

    await repository.setPreference(workspaceId, "chat", null);
    expect(await repository.findByWorkspace(workspaceId)).toEqual([]);
  });

  it("setPreference keeps capabilities independent", async () => {
    await repository.setPreference(workspaceId, "rewrite", { provider: "gemini", model: "g-1" });
    await repository.setPreference(workspaceId, "rerank", { provider: "claude", model: "c-1" });
    const prefs = await repository.findByWorkspace(workspaceId);
    expect(prefs.map((p) => p.capability).sort()).toEqual(["rerank", "rewrite"]);
  });

  it("setPreference throws when no retrieval_settings row exists", async () => {
    await expect(
      repository.setPreference(randomUUID(), "chat", { provider: "openai", model: "x" }),
    ).rejects.toThrow(/retrieval_settings row missing/);
  });
});
