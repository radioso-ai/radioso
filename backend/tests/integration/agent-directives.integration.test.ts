import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AppError } from "../../src/shared/domain/errors.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }

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

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

describeIfDatabase("agent directives persistence", () => {
  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let agentRepository: AgentRepository;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database.kysely);
    workspaceRepository = new WorkspaceRepository(database.kysely);
    agentRepository = new AgentRepository(database.kysely);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  const createAgent = async () => {
    const account = await accountRepository.create({
      name: "Directive Test Org",
      email: `agent-directives-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Directive Test Workspace");
    const agent = await agentRepository.create(workspace.id, { name: "Directive Agent" });
    return { account, workspace, agent };
  };

  it("round-trips authored directives through create, load, update, and delete", async () => {
    const { account, workspace, agent } = await createAgent();

    const created = await agentRepository.createDirective(agent.id, workspace.id, {
      name: "formal-register",
      condition: { kind: "contextual", description: "When answering procurement questions" },
      action: "Use a formal register.",
      requiredCapabilities: ["retrieval.answer"],
      dependsOn: [],
      excludes: [],
      routes: ["retrieval"],
      description: "Tone control",
      metadata: { source: "integration" },
    });

    expect(created.id).toEqual(expect.any(String));
    expect(created.priority).toBeNull();
    const loaded = await agentRepository.findByIdAndWorkspaceId(agent.id, workspace.id);
    expect(loaded?.authoredDirectives ?? []).toHaveLength(1);
    expect((loaded?.authoredDirectives ?? [])[0]).toMatchObject({
      id: created.id,
      agentId: agent.id,
      name: "formal-register",
      condition: { kind: "contextual", description: "When answering procurement questions" },
      action: "Use a formal register.",
      routes: ["retrieval"],
    });

    const updated = await agentRepository.updateDirective(agent.id, workspace.id, created.id, {
      action: "Use a precise formal register.",
    });
    expect(updated.action).toBe("Use a precise formal register.");
    expect(updated.priority).toBeNull();

    expect(await agentRepository.deleteDirective(agent.id, workspace.id, created.id)).toBe(true);
    expect(await agentRepository.listDirectives(agent.id, workspace.id)).toEqual([]);

    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
  });

  it("persists an authored priority and lets it be cleared back to the default", async () => {
    const { account, workspace, agent } = await createAgent();

    const created = await agentRepository.createDirective(agent.id, workspace.id, {
      name: "ranked-tone",
      condition: { kind: "always" },
      action: "Outrank the default formatting when they conflict.",
      priority: 95,
    });
    expect(created.priority).toBe(95);

    const loaded = await agentRepository.findByIdAndWorkspaceId(agent.id, workspace.id);
    expect((loaded?.authoredDirectives ?? [])[0]?.priority).toBe(95);

    const relowered = await agentRepository.updateDirective(agent.id, workspace.id, created.id, {
      priority: 20,
    });
    expect(relowered.priority).toBe(20);

    const cleared = await agentRepository.updateDirective(agent.id, workspace.id, created.id, {
      priority: null,
    });
    expect(cleared.priority).toBeNull();

    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
  });

  it("reports duplicate directive names as conflicts and cascades when the agent is deleted", async () => {
    const { account, workspace, agent } = await createAgent();
    await agentRepository.createDirective(agent.id, workspace.id, {
      name: "formal-register",
      condition: { kind: "always" },
      action: "Use a formal register.",
      routes: ["retrieval"],
    });
    const handoff = await agentRepository.createDirective(agent.id, workspace.id, {
      name: "handoff-tone",
      condition: { kind: "always" },
      action: "Use a calm handoff tone.",
      routes: ["retrieval"],
    });

    await expect(agentRepository.createDirective(agent.id, workspace.id, {
      name: "formal-register",
      condition: { kind: "always" },
      action: "Use a formal register.",
      routes: ["retrieval"],
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: 'A directive named "formal-register" already exists for this agent.',
    } as Partial<AppError>);

    await expect(agentRepository.updateDirective(agent.id, workspace.id, handoff.id, {
      name: "formal-register",
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
      message: 'A directive named "formal-register" already exists for this agent.',
    } as Partial<AppError>);

    const renamed = await agentRepository.updateDirective(agent.id, workspace.id, handoff.id, {
      name: "handoff-confirmed",
    });
    expect(renamed.name).toBe("handoff-confirmed");

    await agentRepository.deleteByIdAndWorkspaceId(agent.id, workspace.id);
    const rows = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agent_directives WHERE agent_id = $1",
      [agent.id],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);

    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
  });

  it("rejects stale agent updates with a conflict", async () => {
    const { account, workspace, agent } = await createAgent();
    const staleUpdatedAt = agent.updatedAt;

    await database.query("SELECT pg_sleep(0.01)");
    await agentRepository.update(agent.id, workspace.id, { name: "Fresh update" }, {
      expectedUpdatedAt: staleUpdatedAt,
    });

    await expect(agentRepository.update(agent.id, workspace.id, { name: "Stale update" }, {
      expectedUpdatedAt: staleUpdatedAt,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
    } as Partial<AppError>);

    await database.query("DELETE FROM accounts WHERE id = $1", [account.id]);
  });
});
