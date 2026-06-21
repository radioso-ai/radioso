import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BootstrapGreetingCacheRepository } from "../../src/db/repositories/bootstrapGreetingCacheRepository.js";
import { Database } from "../../src/shared/infra/database.js";

// Real-Postgres characterization of BootstrapGreetingCacheRepository. The risky behaviour
// is the `save` upsert (ON CONFLICT (workspace_id, agent_id, fingerprint) DO UPDATE): it
// must preserve id/created_at, refresh greeting_text/locale_used, and bump updated_at.
// This is the spec the Kysely migration must preserve.

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) {
    return false;
  }
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = (await canReach(integrationDatabaseUrl)) ? describe : describe.skip;

describeIfDatabase("BootstrapGreetingCacheRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new BootstrapGreetingCacheRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const fingerprint = `fp-${randomUUID()}`;

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Greeting Test Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Greeting Workspace", `route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, "Greeting Agent"],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("save inserts a new cache row", async () => {
    const saved = await repository.save({
      workspaceId,
      agentId,
      fingerprint,
      localeUsed: "en",
      greetingText: "Hello there",
    });

    expect(saved.workspaceId).toBe(workspaceId);
    expect(saved.agentId).toBe(agentId);
    expect(saved.fingerprint).toBe(fingerprint);
    expect(saved.localeUsed).toBe("en");
    expect(saved.greetingText).toBe("Hello there");
    expect(saved.createdAt).toBeInstanceOf(Date);
    expect(saved.updatedAt).toBeInstanceOf(Date);
  });

  it("save upserts on (workspace_id, agent_id, fingerprint): same id, refreshed fields", async () => {
    const first = await repository.findByWorkspaceAgentAndFingerprint(workspaceId, agentId, fingerprint);
    expect(first).not.toBeNull();

    const resaved = await repository.save({
      workspaceId,
      agentId,
      fingerprint,
      localeUsed: null,
      greetingText: "Updated greeting",
    });

    expect(resaved.id).toBe(first!.id);
    expect(resaved.createdAt.getTime()).toBe(first!.createdAt.getTime());
    expect(resaved.localeUsed).toBeNull();
    expect(resaved.greetingText).toBe("Updated greeting");
    expect(resaved.updatedAt.getTime()).toBeGreaterThanOrEqual(first!.updatedAt.getTime());
  });

  it("findByWorkspaceAgentAndFingerprint returns null when no match", async () => {
    expect(
      await repository.findByWorkspaceAgentAndFingerprint(workspaceId, agentId, "missing-fp"),
    ).toBeNull();
  });

  it("findById scopes by workspace and returns null for unknown ids", async () => {
    const saved = await repository.findByWorkspaceAgentAndFingerprint(workspaceId, agentId, fingerprint);
    const found = await repository.findById(workspaceId, saved!.id);
    expect(found?.id).toBe(saved!.id);

    expect(await repository.findById(workspaceId, randomUUID())).toBeNull();
    // wrong workspace must not find it
    expect(await repository.findById(randomUUID(), saved!.id)).toBeNull();
  });
});
