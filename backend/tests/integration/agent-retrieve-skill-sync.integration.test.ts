import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { toJsonb } from "../../src/shared/infra/kysely/sqlHelpers.js";
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

const describeIfDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl) ? describe : describe.skip;

describeIfDatabase("agent retrieve skill sync", () => {
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

  const createWorkspace = async () => {
    const account = await accountRepository.create({
      name: "Retrieve Skill Sync",
      email: `retrieve-skill-sync-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    return workspaceRepository.create(account.id, "Retrieve Skill Sync");
  };

  it("keeps an existing default-answer retrieve skill aligned with agent retrieval edits", async () => {
    const workspace = await createWorkspace();
    const sourceId = randomUUID();
    await database.kysely
      .insertInto("document_sources")
      .values({
        id: sourceId,
        workspace_id: workspace.id,
        name: "Product handbook",
        kind: "manual",
      })
      .executeTakeFirstOrThrow();

    const agent = await agentRepository.create(workspace.id, {
      name: "Docs Agent",
      retrievalEnabled: true,
      sourceScope: { mode: "all" },
      suggestedQuestionsEnabled: true,
    });

    // create() already seeded the default-answer retrieve skill row; overwrite its config
    // to simulate a pre-existing stray field (vectorTopK) the coming update must replace,
    // not merge.
    await database.kysely
      .updateTable("agent_skills")
      .set({
        config: toJsonb({
          sourceScope: "all",
          suggestedQuestionsEnabled: true,
          vectorTopK: 4,
          exposedInputs: { query: true },
        }),
      })
      .where("agent_id", "=", agent.id)
      .where("kind", "=", "retrieve")
      .where("invocation_mode", "=", "default_answer")
      .executeTakeFirstOrThrow();

    const updated = await agentRepository.update(agent.id, workspace.id, {
      retrievalEnabled: false,
      sourceScope: { mode: "selected", sourceIds: [sourceId] },
      suggestedQuestionsEnabled: false,
      skillSettings: {
        "retrieval.answer": {
          vectorTopK: 9,
          customInstruction: "Use the selected product handbook.",
          similarityThreshold: 0.82,
          providerKnob: "preserved",
        },
      },
    });

    expect(updated.retrievalEnabled).toBe(false);
    expect(updated.sourceScope).toEqual({ mode: "selected", sourceIds: [sourceId] });
    expect(updated.suggestedQuestionsEnabled).toBe(false);
    expect(updated.skillSettings["retrieval.answer"]).toMatchObject({
      vectorTopK: 9,
      customInstruction: "Use the selected product handbook.",
      providerKnob: "preserved",
    });

    const readBack = await agentRepository.findByIdAndWorkspaceId(agent.id, workspace.id);
    expect(readBack).toMatchObject({
      retrievalEnabled: false,
      sourceScope: { mode: "selected", sourceIds: [sourceId] },
      suggestedQuestionsEnabled: false,
    });

    const row = await database.kysely
      .selectFrom("agent_skills")
      .select(["enabled", "config"])
      .where("agent_id", "=", agent.id)
      .where("kind", "=", "retrieve")
      .where("invocation_mode", "=", "default_answer")
      .executeTakeFirstOrThrow();
    expect(row.enabled).toBe(false);
    expect(row.config).toMatchObject({
      sourceScope: { sourceIds: [sourceId] },
      suggestedQuestionsEnabled: false,
      vectorTopK: 9,
      instruction: "Use the selected product handbook.",
      providerKnob: "preserved",
      exposedInputs: { query: true },
    });
    expect(row.config).not.toHaveProperty("similarityThreshold");
    expect(row.config).not.toHaveProperty("customInstruction");
  });

  it("create() seeds a default-answer retrieve skill row named 'answer' aligned with retrievalEnabled", async () => {
    const workspace = await createWorkspace();
    const agent = await agentRepository.create(workspace.id, {
      name: "Fresh Agent",
      retrievalEnabled: true,
      sourceScope: { mode: "all" },
      suggestedQuestionsEnabled: true,
    });

    const rows = await database.kysely
      .selectFrom("agent_skills")
      .selectAll()
      .where("agent_id", "=", agent.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      skill_name: "answer",
      kind: "retrieve",
      target_type: "source_scope",
      target_id: null,
      invocation_mode: "default_answer",
      enabled: true,
    });
    expect(rows[0].config).toMatchObject({
      sourceScope: "all",
      suggestedQuestionsEnabled: true,
      exposedInputs: { query: true },
    });

    // GET /agents/:id/skills (the unified Skills UI listing) has a card to show.
    const listed = await database.kysely
      .selectFrom("agent_skills")
      .select(["skill_name"])
      .where("agent_id", "=", agent.id)
      .execute();
    expect(listed.map((row) => row.skill_name)).toContain("answer");
  });

  it("create() with retrievalEnabled false yields the default-answer skill disabled", async () => {
    const workspace = await createWorkspace();
    const agent = await agentRepository.create(workspace.id, {
      name: "Retrieval Off Agent",
      retrievalEnabled: false,
      sourceScope: { mode: "all" },
    });

    const row = await database.kysely
      .selectFrom("agent_skills")
      .select(["enabled"])
      .where("agent_id", "=", agent.id)
      .where("skill_name", "=", "answer")
      .executeTakeFirstOrThrow();
    expect(row.enabled).toBe(false);
  });

  it("update() creates the default-answer retrieve skill row when a legacy agent has none", async () => {
    const workspace = await createWorkspace();
    const agent = await agentRepository.create(workspace.id, {
      name: "Legacy Agent",
      retrievalEnabled: true,
      sourceScope: { mode: "all" },
    });
    // Simulate an agent created between #766 and this fix: no retrieve skill row at all,
    // the exact defect this repository's create() and update() now both self-heal.
    await database.kysely.deleteFrom("agent_skills").where("agent_id", "=", agent.id).execute();
    const before = await database.kysely
      .selectFrom("agent_skills")
      .selectAll()
      .where("agent_id", "=", agent.id)
      .execute();
    expect(before).toHaveLength(0);

    const updated = await agentRepository.update(agent.id, workspace.id, {
      retrievalEnabled: false,
      suggestedQuestionsEnabled: false,
    });
    expect(updated.retrievalEnabled).toBe(false);

    const row = await database.kysely
      .selectFrom("agent_skills")
      .selectAll()
      .where("agent_id", "=", agent.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      skill_name: "answer",
      kind: "retrieve",
      target_type: "source_scope",
      target_id: null,
      invocation_mode: "default_answer",
      enabled: false,
    });
  });

  it("does not insert a second default-answer skill when the agent already has a differently-kinded one", async () => {
    const workspace = await createWorkspace();
    const agent = await agentRepository.create(workspace.id, { name: "Swapped Default Agent" });
    // Replace the auto-created retrieve/default-answer row with a differently-kinded
    // default-answer skill - `agent_skills_one_default_answer` allows exactly one, and no
    // capability other than `retrieve` supports `default_answer` today, but this repository
    // must not assume that and displace an operator's (future) deliberate choice.
    await database.kysely.deleteFrom("agent_skills").where("agent_id", "=", agent.id).execute();
    await database.kysely
      .insertInto("agent_skills")
      .values({
        id: randomUUID(),
        workspace_id: workspace.id,
        agent_id: agent.id,
        skill_name: "custom_default",
        kind: "notify",
        target_type: "notify_delivery",
        target_id: null,
        invocation_mode: "default_answer",
        enabled: true,
        config: toJsonb({}),
      })
      .executeTakeFirstOrThrow();

    await agentRepository.update(agent.id, workspace.id, { retrievalEnabled: false });

    const rows = await database.kysely
      .selectFrom("agent_skills")
      .selectAll()
      .where("agent_id", "=", agent.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].skill_name).toBe("custom_default");

    // This agent's default-answer skill is deliberately not named "answer" - a shape nothing
    // in production can produce today - which would otherwise poison any other integration
    // test that scans every agent's default-answer skill (e.g. a migration re-run) sharing
    // this database. Clean it up rather than leaving it behind.
    await agentRepository.deleteByIdAndWorkspaceId(agent.id, workspace.id);
  });
});
