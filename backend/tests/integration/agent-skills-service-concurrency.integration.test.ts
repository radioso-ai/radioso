import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { McpConnectionRepository } from "../../src/db/repositories/mcpConnectionRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AgentSkillsService } from "../../src/modules/agentSkills/service.js";
import { AgentSkillRepository, type AgentSkillRepositoryPort } from "../../src/modules/agentSkills/repository.js";
import { createDefaultSkillCapabilityRegistry } from "../../src/modules/skills/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delays the return of `findById` without touching what it read. `AgentSkillsService.update`
 * calls this exactly once, before it validates a patch and before it ever reaches the
 * repository's own locked transaction, so holding it open here forces both concurrent
 * `service.update()` calls to complete *their* pre-lock read of the row - each individually
 * seeing the same not-yet-written config - before either proceeds to the repository. Without
 * this, two calls issued back-to-back over a local Postgres connection can otherwise run start
 * to finish (including commit) well within the time it takes the second call's first query to
 * even reach the wire, which would prove nothing about the race this guards against.
 */
class DelayedReadAgentSkillRepository implements AgentSkillRepositoryPort {
  constructor(private readonly inner: AgentSkillRepositoryPort, private readonly readDelayMs: number) {}

  async findById(...args: Parameters<AgentSkillRepositoryPort["findById"]>): ReturnType<AgentSkillRepositoryPort["findById"]> {
    const result = await this.inner.findById(...args);
    await delay(this.readDelayMs);
    return result;
  }

  create(...args: Parameters<AgentSkillRepositoryPort["create"]>): ReturnType<AgentSkillRepositoryPort["create"]> {
    return this.inner.create(...args);
  }

  findByName(...args: Parameters<AgentSkillRepositoryPort["findByName"]>): ReturnType<AgentSkillRepositoryPort["findByName"]> {
    return this.inner.findByName(...args);
  }

  findByAgentAndName(...args: Parameters<AgentSkillRepositoryPort["findByAgentAndName"]>): ReturnType<AgentSkillRepositoryPort["findByAgentAndName"]> {
    return this.inner.findByAgentAndName(...args);
  }

  findDefaultAnswer(...args: Parameters<AgentSkillRepositoryPort["findDefaultAnswer"]>): ReturnType<AgentSkillRepositoryPort["findDefaultAnswer"]> {
    return this.inner.findDefaultAnswer(...args);
  }

  listByAgent(...args: Parameters<AgentSkillRepositoryPort["listByAgent"]>): ReturnType<AgentSkillRepositoryPort["listByAgent"]> {
    return this.inner.listByAgent(...args);
  }

  listByWorkspace(...args: Parameters<AgentSkillRepositoryPort["listByWorkspace"]>): ReturnType<AgentSkillRepositoryPort["listByWorkspace"]> {
    return this.inner.listByWorkspace(...args);
  }

  update(...args: Parameters<AgentSkillRepositoryPort["update"]>): ReturnType<AgentSkillRepositoryPort["update"]> {
    return this.inner.update(...args);
  }

  remove(...args: Parameters<AgentSkillRepositoryPort["remove"]>): ReturnType<AgentSkillRepositoryPort["remove"]> {
    return this.inner.remove(...args);
  }
}

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

// Verifies AgentSkillsService.update against real, concurrent Postgres transactions - the
// in-memory repository test double cannot exercise the real FOR UPDATE row lock, so it cannot
// honestly demonstrate the race this guards: AgentSkillsService.update validates one
// pre-transaction candidate, but AgentSkillRepository.update recomputes the deep merge *inside*
// its own locked transaction (against whatever the row actually holds at that moment, which a
// concurrent writer may have already changed). Two individually-valid partial patches can
// therefore compose, under the lock, into a config nobody ever validated.
describeIfDatabase("AgentSkillsService.update concurrency (Kysely/Postgres)", () => {
  let database: Database;
  let service: AgentSkillsService;
  let repository: AgentSkillRepository;
  let mcpConnectionRepository: McpConnectionRepository;
  let workspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
    repository = new AgentSkillRepository(database.kysely);
    mcpConnectionRepository = new McpConnectionRepository(database.kysely);

    const accountRepository = new AccountRepository(database.kysely);
    const workspaceRepository = new WorkspaceRepository(database.kysely);
    const agentRepository = new AgentRepository(database.kysely);
    const account = await accountRepository.create({
      name: "Skill Concurrency IT",
      email: `agent-skill-concurrency-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Skill Concurrency IT");
    workspaceId = workspace.id;
    const agent = await agentRepository.create(workspace.id, { name: "Skill Concurrency Agent" });
    agentId = agent.id;
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
  });

  it("does not let two concurrent, individually-valid partial patches compose into a config the capability schema rejects", async () => {
    // mcp_tool's own schema (mcpToolConfigSchema) rejects a key that appears in both
    // boundParams and exposedParams. Patch A adds `foo` only to boundParams; patch B adds `foo`
    // only to exposedParams. Read against the *original* stored config (neither key present
    // yet), each patch is individually valid - which is exactly what AgentSkillsService.update
    // validates before ever calling the repository. Only inside the repository's FOR UPDATE
    // transaction does the real, current base get re-read: whichever patch's transaction runs
    // second sees the first's already-committed change, and its merge composes an invalid config.
    const connection = await mcpConnectionRepository.create({
      agentId,
      displayName: "Test MCP connection",
      serverUrl: "https://mcp.example.com/rpc",
      authMethod: "access_token",
      credentialCiphertext: "unused-in-this-test",
      encryptionKeyId: "unused-in-this-test",
      status: "authorized",
    });
    const targetId = connection.id;
    service = new AgentSkillsService({
      repository,
      capabilities: createDefaultSkillCapabilityRegistry({
        mcp_tool: async () => [{ id: targetId, label: connection.displayName }],
      }),
    });
    const raceService = new AgentSkillsService({
      repository: new DelayedReadAgentSkillRepository(repository, 50),
      capabilities: createDefaultSkillCapabilityRegistry({
        mcp_tool: async () => [{ id: targetId, label: connection.displayName }],
      }),
    });

    const created = await service.create(workspaceId, agentId, {
      name: `concurrent_tool_${randomUUID().slice(0, 8)}`,
      capability: "mcp_tool",
      target: { kind: "mcp_connection", id: targetId },
      config: { toolName: "do_thing", boundParams: {}, exposedParams: {} },
      invocationMode: "routine_named",
      enabled: true,
    });

    const [resultA, resultB] = await Promise.allSettled([
      raceService.update(workspaceId, agentId, created.id, {
        config: { boundParams: { foo: "bar" } },
      }),
      raceService.update(workspaceId, agentId, created.id, {
        config: { exposedParams: { foo: {} } },
      }),
    ]);

    // Exactly one of the two concurrent patches must lose the race: the repository's lock
    // serializes them, and whichever applies second produces a merge the capability schema
    // rejects, so it must be refused rather than silently persisted.
    const settled = [resultA, resultB];
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });

    const persisted = await repository.findById(workspaceId, agentId, created.id);
    const capability = createDefaultSkillCapabilityRegistry().get("mcp_tool")!;
    expect(capability.validateConfig(persisted!.config).success).toBe(true);
  });
});
