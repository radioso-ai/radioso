import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AgentSkillRepository } from "../../src/modules/agentSkills/repository.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) return false;
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = (await canReachIntegrationDatabase(integrationDatabaseUrl)) ? describe : describe.skip;

// Verifies the concrete Kysely-backed AgentSkillRepository against Postgres — the
// in-memory facade test cannot exercise the jsonb shallow-merge on update, the
// explicit-null vs absent target_id semantics, or DELETE row counting.
describeIfDatabase("AgentSkillRepository (Kysely) against Postgres", () => {
  let database: Database;
  let repository: AgentSkillRepository;
  let workspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
    repository = new AgentSkillRepository(database.kysely);

    const accountRepository = new AccountRepository(database.kysely);
    const workspaceRepository = new WorkspaceRepository(database.kysely);
    const agentRepository = new AgentRepository(database.kysely);
    const account = await accountRepository.create({
      name: "Skill Repo IT",
      email: `agent-skill-repo-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Skill Repo IT");
    workspaceId = workspace.id;
    const agent = await agentRepository.create(workspace.id, { name: "Skill Repo Agent" });
    agentId = agent.id;
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
  });

  it("creates, reads by id/name, and lists by agent in name order", async () => {
    const created = await repository.create({
      workspaceId,
      agentId,
      skillName: "alpha",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: { delivery: { recipientEmails: ["a@example.com"], webhook: null } },
      invocationMode: "routine_named",
      enabled: true,
    });
    expect(created).toMatchObject({
      skillName: "alpha",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      invocationMode: "routine_named",
      enabled: true,
      config: { delivery: { recipientEmails: ["a@example.com"], webhook: null } },
    });

    await repository.create({
      workspaceId,
      agentId,
      skillName: "beta",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: {},
      invocationMode: "routine_named",
      enabled: false,
    });

    expect(await repository.findById(workspaceId, agentId, created.id)).toMatchObject({ skillName: "alpha" });
    expect(await repository.findByName(workspaceId, agentId, "beta")).toMatchObject({ enabled: false });
    expect((await repository.listByAgent(workspaceId, agentId)).map((s) => s.skillName)).toEqual(["alpha", "beta"]);
    // Cross-workspace / cross-agent isolation.
    expect(await repository.findByName(randomUUID(), agentId, "alpha")).toBeNull();
    expect(await repository.findById(workspaceId, randomUUID(), created.id)).toBeNull();
  });

  it("shallow-merges config and honors explicit-null vs absent target_id on update", async () => {
    // `retrieve`/`source_scope` targets are not UUID-validated by the target-reference
    // trigger, so an arbitrary text target_id keeps this a pure repository-mechanics test.
    const created = await repository.create({
      workspaceId,
      agentId,
      skillName: "gamma",
      kind: "retrieve",
      targetType: "source_scope",
      targetId: "scope-1",
      config: { boundPayload: { a: 1 }, exposedPayload: { x: true } },
      invocationMode: "routine_named",
      enabled: true,
    });

    // Partial config update: only boundPayload provided → exposedPayload survives the merge.
    const merged = await repository.update(workspaceId, agentId, created.id, {
      config: { boundPayload: { a: 2, b: 3 } },
    });
    expect(merged?.config).toEqual({ boundPayload: { a: 2, b: 3 }, exposedPayload: { x: true } });
    // target_id untouched when the key is absent.
    expect(merged?.targetId).toBe("scope-1");

    // enabled:false must persist (not be treated as "leave unchanged").
    const disabled = await repository.update(workspaceId, agentId, created.id, { enabled: false });
    expect(disabled?.enabled).toBe(false);

    // Explicit null target_id clears it.
    const cleared = await repository.update(workspaceId, agentId, created.id, { targetId: null });
    expect(cleared?.targetId).toBeNull();

    // Update against a foreign agent is a no-op (returns null).
    expect(await repository.update(workspaceId, randomUUID(), created.id, { enabled: true })).toBeNull();
  });

  it("refuses an update whose expectedUpdatedAt no longer matches, and leaves the row unchanged", async () => {
    const created = await repository.create({
      workspaceId,
      agentId,
      skillName: "epsilon",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: { delivery: { recipientEmails: ["a@example.com"], webhook: null } },
      invocationMode: "routine_named",
      enabled: true,
    });
    const draftedAt = created.updatedAt;

    // A concurrent edit lands after the caller read draftedAt but before it calls update.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const edited = await repository.update(workspaceId, agentId, created.id, { enabled: false });
    expect(edited?.updatedAt.getTime()).toBeGreaterThan(draftedAt.getTime());

    // The version check lives in the UPDATE's own WHERE predicate: a stale expectedUpdatedAt
    // must be a no-op (null), not a partial or unconditional write.
    const stale = await repository.update(
      workspaceId,
      agentId,
      created.id,
      { config: { delivery: { recipientEmails: ["hijacked@example.com"], webhook: null } }, expectedUpdatedAt: draftedAt },
    );
    expect(stale).toBeNull();
    expect((await repository.findById(workspaceId, agentId, created.id))?.config).not.toMatchObject({
      delivery: { recipientEmails: ["hijacked@example.com"] },
    });

    // A fresh expectedUpdatedAt (matching the edit) succeeds.
    const fresh = (await repository.findById(workspaceId, agentId, created.id))!;
    const applied = await repository.update(workspaceId, agentId, created.id, {
      enabled: true,
      expectedUpdatedAt: fresh.updatedAt,
    });
    expect(applied?.enabled).toBe(true);
  });

  it("removes only the matching row and reports whether a row was deleted", async () => {
    const created = await repository.create({
      workspaceId,
      agentId,
      skillName: "delta",
      kind: "notify",
      targetType: "notify_delivery",
      targetId: null,
      config: {},
      invocationMode: "routine_named",
      enabled: true,
    });

    expect(await repository.remove(workspaceId, randomUUID(), created.id)).toBe(false);
    expect(await repository.findById(workspaceId, agentId, created.id)).not.toBeNull();
    expect(await repository.remove(workspaceId, agentId, created.id)).toBe(true);
    expect(await repository.findById(workspaceId, agentId, created.id)).toBeNull();
  });
});
