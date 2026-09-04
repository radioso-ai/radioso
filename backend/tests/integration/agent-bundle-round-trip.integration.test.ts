import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAgentBundleServices } from "../../src/app/composition/agentBundleComposition.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { AgentSkillRepository } from "../../src/modules/agentSkills/public.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AgentSkillsService } from "../../src/modules/agentSkills/public.js";
import { AgentService } from "../../src/modules/agents/services/agentService.js";
import { AuthoredDirectiveService } from "../../src/modules/agents/services/authoredDirectiveService.js";
import { ContextVariableService } from "../../src/modules/context-variables/public.js";
import { RoutineDefinitionService } from "../../src/modules/routines/public.js";
import { createDefaultSkillCapabilityRegistry } from "../../src/modules/skills/public.js";
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

/**
 * The unit tests drive the bundle services against in-memory fakes, which do not
 * enforce the constraints the real tables carry: `agent_skills`' unique
 * (agent_id, skill_name), `routine_definition`'s unique (agent_id, name, version),
 * and `agent_context_variables`' CHECK that a resolver-sourced enablement has a
 * resolver skill. A bundle written by the export side has to survive all three on
 * the way back in.
 */
describeIfDatabase("agent bundle round trip against Postgres", () => {
  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let agentRepository: AgentRepository;
  let agentSkillRepository: AgentSkillRepository;
  let contextVariableRepository: ContextVariableRepository;
  let routineDefinitionRepository: RoutineDefinitionRepository;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database.kysely);
    workspaceRepository = new WorkspaceRepository(database.kysely);
    agentRepository = new AgentRepository(database.kysely);
    agentSkillRepository = new AgentSkillRepository(database.kysely);
    contextVariableRepository = new ContextVariableRepository(database.kysely);
    routineDefinitionRepository = new RoutineDefinitionRepository(database.kysely);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  const seedWorkspace = async () => {
    const account = await accountRepository.create({
      name: "Bundle Test Org",
      email: `agent-bundle-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Bundle Test Workspace");
    return { account, workspace };
  };

  it("carries an agent's authored data across a real database round trip", async () => {
    const { workspace } = await seedWorkspace();

    const source = await agentRepository.create(workspace.id, {
      name: "Procurement Bot",
      internalName: "Procurement (EU)",
      customInstruction: "Answer with precise procurement guidance.",
      handoffOnRetrievalMiss: true,
    });

    await agentRepository.createDirective(source.id, workspace.id, {
      name: "procurement-tone",
      condition: { kind: "always" },
      action: "Use the procurement team's preferred tone.",
      requiredCapabilities: [],
      dependsOn: [],
      excludes: [],
      routes: [],
      description: null,
      metadata: {},
    });

    const skill = await agentSkillRepository.create({
      workspaceId: workspace.id,
      agentId: source.id,
      skillName: "knowledge_lookup",
      kind: "retrieve",
      targetType: "source_scope",
      targetId: null,
      config: { vectorTopK: 9 },
      invocationMode: "routine_named",
      enabled: true,
    });

    const variable = await contextVariableRepository.create({
      workspaceId: workspace.id,
      name: "plan_tier",
      description: null,
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
    });
    await contextVariableRepository.upsertEnablement({
      agentId: source.id,
      variableId: variable.id,
      source: "resolver",
      resolverSkillId: skill.id,
      maxAgeSeconds: 300,
      resolverTimeoutMs: 2000,
      surfacing: "on_reference",
      enabled: true,
    });

    const draft = await routineDefinitionRepository.createDraft(source.id, {
      name: "answer-with-context",
      activation: {
        triggerDescription: "When the visitor asks about their plan",
        gateRef: null,
        priority: 10,
        reentryMode: "once_per_conversation",
      },
      slots: [{
        stableSlotId: "slot_topic",
        key: "topic",
        type: "text",
        required: true,
        description: null,
        ordinal: 0,
      }],
      steps: [{
        stableStepId: "step_collect_topic",
        kind: "chat",
        instruction: "Ask for {{slot.topic}}.",
        toolRef: null,
        ordinal: 0,
        metadata: {},
      }],
      transitions: [{
        fromStep: "step_collect_topic",
        toRef: "terminal_complete",
        guardKind: "default",
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: 0,
      }],
      terminals: [{
        stableStepId: "terminal_complete",
        kind: "complete",
        instruction: "Explain the plan difference for {{slot.topic}}.",
        ordinal: 1,
      }],
    } as never);
    await routineDefinitionRepository.publish(source.id, draft.id);

    const services = buildServices();

    const bundle = await services.exportService.export(workspace.id, source.id);

    expect(bundle.agent.internalName).toBe("Procurement (EU)");
    expect(bundle.agent.handoffOnRetrievalMiss).toBe(true);
    expect(bundle.routines.map((routine) => routine.name)).toEqual(["answer-with-context"]);
    expect(bundle.contextVariables).toEqual([expect.objectContaining({
      variableName: "plan_tier",
      resolverSkillName: "knowledge_lookup",
      source: "resolver",
    })]);
    // No database identity anywhere in the portable collections.
    const portable = JSON.stringify({
      routines: bundle.routines,
      contextVariables: bundle.contextVariables,
      agentSkills: bundle.agentSkills,
    });
    for (const id of [source.id, skill.id, variable.id, draft.id, workspace.id]) {
      expect(portable).not.toContain(id);
    }

    const imported = await services.importService.import(workspace.id, bundle);

    expect(imported.agentId).not.toBe(source.id);
    expect(imported.unresolved).toEqual([]);

    // Re-exporting the import produces the same portable document, which is what
    // makes a bundle diffable in version control.
    const reExported = await services.exportService.export(workspace.id, imported.agentId);
    expect(reExported.agent).toEqual(bundle.agent);
    expect(reExported.routines).toEqual(bundle.routines);
    expect(reExported.contextVariables).toEqual(bundle.contextVariables);
    expect(reExported.agentSkills).toEqual(bundle.agentSkills);

    // The routine published rather than landing as a draft, so the imported agent
    // actually runs it.
    const importedRoutines = await routineDefinitionRepository.listByAgent(imported.agentId);
    expect(importedRoutines.filter((routine) => routine.status === "published")).toHaveLength(1);

    // The resolver enablement resolved against the imported agent's own skill row,
    // not the source agent's — the CHECK constraint would reject a null one.
    const enablements = await contextVariableRepository.listByAgent(workspace.id, imported.agentId);
    expect(enablements).toHaveLength(1);
    expect(enablements[0].resolverSkillId).not.toBe(skill.id);
    expect(enablements[0].resolverSkillId).not.toBeNull();
  });

  it("removes the agent it created when the import fails in a workspace that had none", async () => {
    // The dashboard offers import from the zero-agent empty state, so the first
    // agent a workspace ever has can be one this import created. The operator-facing
    // rule that a workspace keeps at least one agent must not strand it there.
    const { workspace } = await seedWorkspace();
    expect(await agentRepository.listByWorkspaceId(workspace.id)).toHaveLength(0);

    const services = buildServices();
    const bundle = {
      bundleVersion: 1,
      portability: {},
      agent: {
        ...(await (async () => {
          const donor = await agentRepository.create(workspace.id, { name: "Donor" });
          const exported = await services.exportService.export(workspace.id, donor.id);
          await agentRepository.deleteByIdAndWorkspaceId(donor.id, workspace.id);
          return exported.agent;
        })()),
        // A directive the service rejects: directive writes are fatal, so this drives
        // the compensating delete.
        authoredDirectives: [{ name: "", action: "" }],
      },
      routines: [],
      contextVariables: [],
      agentSkills: [],
    } as never;

    await expect(services.importService.import(workspace.id, bundle)).rejects.toThrow();

    // Nothing left behind, and no dangling workspace default pointing at it.
    expect(await agentRepository.listByWorkspaceId(workspace.id)).toHaveLength(0);
  });

  it("reports a context variable the target workspace does not have, and still creates the agent", async () => {
    const { workspace: sourceWorkspace } = await seedWorkspace();
    const { workspace: targetWorkspace } = await seedWorkspace();

    const source = await agentRepository.create(sourceWorkspace.id, { name: "Sourced Bot" });
    const variable = await contextVariableRepository.create({
      workspaceId: sourceWorkspace.id,
      name: "plan_tier",
      description: null,
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "on_reference",
    });
    await contextVariableRepository.upsertEnablement({
      agentId: source.id,
      variableId: variable.id,
      source: "pushed",
      resolverSkillId: null,
      maxAgeSeconds: null,
      resolverTimeoutMs: null,
      surfacing: "always",
      enabled: true,
    });

    const services = buildServices();
    const bundle = await services.exportService.export(sourceWorkspace.id, source.id);

    const imported = await services.importService.import(targetWorkspace.id, bundle);

    expect(imported.agentId).toEqual(expect.any(String));
    expect(imported.unresolved).toContainEqual(expect.objectContaining({
      kind: "context_variable_missing",
      element: "contextVariable:plan_tier",
    }));
    const enablements = await contextVariableRepository.listByAgent(targetWorkspace.id, imported.agentId);
    expect(enablements).toHaveLength(0);
  });

  /**
   * Assembled through the same `createAgentBundleServices` the server uses, so the
   * composition adapters are under test here too rather than being re-implemented
   * by the test in a way that could drift from production wiring.
   */
  function buildServices() {
    const capabilityRegistry = createDefaultSkillCapabilityRegistry();
    const agentSkillsService = new AgentSkillsService({
      repository: agentSkillRepository,
      capabilities: capabilityRegistry,
    });
    const agentService = new AgentService(agentRepository, workspaceRepository);
    const authoredDirectiveService = new AuthoredDirectiveService({
      repository: agentRepository,
      // Coherence is advisory and LLM-backed; this test is about persistence, so it
      // returns the "no conflicts" verdict rather than reaching a model.
      coherenceChecker: { check: async () => ({ coherent: true, conflicts: [], rationale: "Not checked in this test." }) },
      registeredCapabilityNames: new Set<string>(),
    });
    const contextVariableService = new ContextVariableService({
      repository: contextVariableRepository,
      agentReader: {
        get: async (workspaceId, agentId) => agentRepository.findByIdAndWorkspaceId(agentId, workspaceId),
      },
      agentSkillsReader: {
        list: async (workspaceId, agentId) => agentSkillRepository.listByAgent(workspaceId, agentId),
      },
    });
    const routineDefinitionService = new RoutineDefinitionService({
      agentRepository,
      repository: routineDefinitionRepository,
      contextVariableReader: {
        listByAgent: (workspaceId, agentId) => contextVariableService.listByAgent(workspaceId, agentId),
      },
    });

    return createAgentBundleServices({
      agentService,
      authoredDirectiveService,
      agentSkillsService,
      contextVariableService,
      routineDefinitionService,
      capabilityRegistry,
      agentRepository,
      mcpConnectionRepository: { listByAgent: async () => [] },
      externalSkillDefinitionRepository: { listByAgent: async () => [] },
    });
  }
});
