import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { withAgentDraftMutation } from "../../src/db/repositories/agentDraftMutation.js";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { ContextVariableRepository } from "../../src/db/repositories/contextVariableRepository.js";
import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import { RoutineDefinitionService, type RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const emptySnapshot = {
  customInstruction: null,
  directives: [],
  routines: [],
  contextVariableEnablements: [],
};

const directiveInput = (name: string, action = "Use a formal register.") => ({
  name,
  condition: { kind: "always" as const },
  action,
});

const routineInput = (label: string): RoutineDefinitionDraftInput => ({
  name: "atomic-routine",
  enabled: true,
  activation: { triggerDescription: `Run ${label}`, gateRef: null, priority: 1, reentryMode: "once_per_conversation" },
  slots: [],
  steps: [{ stableStepId: "step_one", kind: "chat", instruction: label, toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "step_one", toRef: "terminal_done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
  terminals: [{ stableStepId: "terminal_done", kind: "complete", instruction: "Done", ordinal: 1 }],
});

describeDb("agent directive draft mutations", () => {
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  let database: Database;
  let agents: AgentRepository;
  let revisions: AgentRevisionRepository;
  let contextVariables: ContextVariableRepository;
  let routines: RoutineDefinitionRepository;

  const createAgentWithDraft = async () => {
    const agentId = randomUUID();
    await database.query(
      "INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)",
      [agentId, workspaceId, `directive-${agentId}`],
    );
    await database.query(
      "INSERT INTO agent_drafts (agent_id, workspace_id, generation, snapshot) VALUES ($1, $2, 1, $3::jsonb)",
      [agentId, workspaceId, JSON.stringify(emptySnapshot)],
    );
    return agentId;
  };

  beforeAll(async () => {
    database = new Database(url!);
    await runAllTestMigrations(database);
    agents = new AgentRepository(database.kysely);
    revisions = new AgentRevisionRepository(database.kysely);
    contextVariables = new ContextVariableRepository(database.kysely);
    routines = new RoutineDefinitionRepository(database.kysely);
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "directive draft", `directive-draft-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "directive draft", `directive-draft-${workspaceId}`],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close();
  });

  it("rolls back the authored write when the saved draft cannot be validated", async () => {
    const agentId = await createAgentWithDraft();
    await database.query(
      "UPDATE agent_drafts SET snapshot = $1::jsonb WHERE agent_id = $2",
      [JSON.stringify({ ...emptySnapshot, customInstruction: 42 }), agentId],
    );

    await expect(agents.createDirective(agentId, workspaceId, directiveInput("invalid-draft"))).rejects.toThrow();
    expect(await agents.listDirectives(agentId, workspaceId)).toEqual([]);
    const [draft] = await database.query<{ generation: number }>(
      "SELECT generation FROM agent_drafts WHERE agent_id = $1",
      [agentId],
    );
    expect(draft?.generation).toBe(1);
  });

  it("rolls back an authored operation that fails after its write", async () => {
    const agentId = await createAgentWithDraft();
    const before = await agents.findByIdAndWorkspaceId(agentId, workspaceId);

    await expect(
      withAgentDraftMutation(database.kysely, workspaceId, agentId, async (trx, snapshot) => {
        await trx
          .updateTable("agents")
          .set({ name: "must roll back" })
          .where("id", "=", agentId)
          .executeTakeFirstOrThrow();
        throw new Error(`test fault after authored write at generation ${snapshot.directives.length}`);
      }),
    ).rejects.toThrow("test fault after authored write");

    await expect(agents.findByIdAndWorkspaceId(agentId, workspaceId)).resolves.toMatchObject({ name: before?.name });
    await expect(revisions.readDraft(workspaceId, agentId)).resolves.toMatchObject({ generation: 1 });
  });

  it("rejects nested same-agent draft mutations instead of persisting an outer stale snapshot", async () => {
    const agentId = await createAgentWithDraft();

    await expect(
      withAgentDraftMutation(database.kysely, workspaceId, agentId, async (trx, snapshot) => {
        await withAgentDraftMutation(trx, workspaceId, agentId, async (_innerTrx, innerSnapshot) => ({
          result: undefined,
          snapshot: { ...innerSnapshot, customInstruction: "inner" },
        }));
        return { result: undefined, snapshot: { ...snapshot, customInstruction: "outer" } };
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(revisions.readDraft(workspaceId, agentId)).resolves.toMatchObject({
      generation: 1,
      snapshot: { customInstruction: null },
    });
  });

  it("serializes same-directive writes so the draft projection equals authored storage", async () => {
    const agentId = await createAgentWithDraft();
    const created = await agents.createDirective(agentId, workspaceId, directiveInput("serialized"));

    await Promise.all([
      agents.updateDirective(agentId, workspaceId, created.id, { action: "Use a concise formal register." }),
      agents.updateDirective(agentId, workspaceId, created.id, { action: "Use an exact formal register." }),
    ]);

    const [authored] = await agents.listDirectives(agentId, workspaceId);
    const draft = await revisions.readDraft(workspaceId, agentId);
    expect(draft?.generation).toBe(4);
    expect(draft?.snapshot.directives).toEqual([authored]);
  });

  it("bumps generation only for successful directive commands, including delete", async () => {
    const agentId = await createAgentWithDraft();
    const created = await agents.createDirective(agentId, workspaceId, directiveInput("delete-boundary"));
    await database.query("SELECT pg_sleep(0.01)");
    const updated = await agents.updateDirective(agentId, workspaceId, created.id, {
      action: "Use a precise formal register.",
    });

    await expect(
      agents.deleteDirective(agentId, workspaceId, created.id, { expectedUpdatedAt: created.updatedAt }),
    ).resolves.toBe(false);
    expect((await revisions.readDraft(workspaceId, agentId))?.generation).toBe(3);

    await expect(
      agents.deleteDirective(agentId, workspaceId, created.id, { expectedUpdatedAt: updated.updatedAt }),
    ).resolves.toBe(true);
    await expect(revisions.readDraft(workspaceId, agentId)).resolves.toMatchObject({
      generation: 4,
      snapshot: { directives: [] },
    });
  });

  it("makes a candidate observe either side of a directive command, never a partial projection", async () => {
    const agentId = await createAgentWithDraft();
    const [created, candidate] = await Promise.all([
      agents.createDirective(agentId, workspaceId, directiveInput("candidate-boundary")),
      revisions.createCandidate(workspaceId, agentId, { id: randomUUID(), expectedDraftGeneration: 1 }),
    ]);
    const draft = await revisions.readDraft(workspaceId, agentId);

    if (candidate !== "conflict") {
      expect(candidate.sourceDraftGeneration).toBe(1);
      expect(candidate.snapshot.directives).toEqual([]);
    }
    expect(draft?.snapshot.directives).toEqual([created]);
    expect(draft?.generation).toBe(2);
  });

  it("makes publication observe either side of a directive command, never its authored-row half", async () => {
    const agentId = await createAgentWithDraft();
    const candidate = await revisions.createCandidate(workspaceId, agentId, {
      id: randomUUID(),
      expectedDraftGeneration: 1,
    });
    if (candidate === "conflict") {
      throw new Error("initial candidate unexpectedly conflicted");
    }

    const [created, publication] = await Promise.all([
      agents.createDirective(agentId, workspaceId, directiveInput("publish-boundary")),
      revisions.publish({
        workspaceId,
        agentId,
        actorAccountId: null,
        revisionId: candidate.id,
        expectedDraftGeneration: 1,
        expectedPublishedRevisionId: null,
        idempotencyKey: randomUUID(),
      }),
    ]);
    const draft = await revisions.readDraft(workspaceId, agentId);

    expect(draft?.generation).toBe(2);
    expect(draft?.snapshot.directives).toEqual([created]);
    expect(draft?.basePublishedRevisionId).toBe(publication === "conflict" ? null : candidate.id);
  });

  it("keeps custom-instruction authoring storage and the draft in sync across save, reload, and stale failure", async () => {
    const agentId = await createAgentWithDraft();
    const initial = await agents.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!initial) throw new Error("agent was not created");

    await agents.update(agentId, workspaceId, { name: "live-only rename" });
    await expect(revisions.readDraft(workspaceId, agentId)).resolves.toMatchObject({
      generation: 1,
      snapshot: { customInstruction: null },
    });
    const liveOnly = await agents.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!liveOnly) throw new Error("agent disappeared after a live-only update");

    const candidate = await revisions.createCandidate(workspaceId, agentId, {
      id: randomUUID(),
      expectedDraftGeneration: 1,
    });
    if (candidate === "conflict") throw new Error("candidate unexpectedly conflicted");

    await database.query("SELECT pg_sleep(0.01)");
    const saved = await agents.updateCustomInstruction(agentId, workspaceId, "Draft instruction");
    expect((await agents.findByIdAndWorkspaceId(agentId, workspaceId))?.customInstruction).toBe("Draft instruction");
    expect(await revisions.readDraft(workspaceId, agentId)).toMatchObject({
      generation: 2,
      snapshot: { customInstruction: "Draft instruction" },
    });
    expect(candidate.snapshot.customInstruction).toBeNull();

    await expect(
      agents.updateCustomInstruction(agentId, workspaceId, "stale instruction", { expectedUpdatedAt: liveOnly.updatedAt }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await agents.findByIdAndWorkspaceId(agentId, workspaceId))?.customInstruction).toBe(saved.customInstruction);
    await expect(revisions.readDraft(workspaceId, agentId)).resolves.toMatchObject({
      generation: 2,
      snapshot: { customInstruction: "Draft instruction" },
    });
  });

  it("serializes concurrent custom-instruction writes without a divergent reload", async () => {
    const agentId = await createAgentWithDraft();
    await Promise.all([
      agents.updateCustomInstruction(agentId, workspaceId, "First concurrent instruction"),
      agents.updateCustomInstruction(agentId, workspaceId, "Second concurrent instruction"),
    ]);

    const agent = await agents.findByIdAndWorkspaceId(agentId, workspaceId);
    const draft = await revisions.readDraft(workspaceId, agentId);
    expect(draft?.generation).toBe(3);
    expect(draft?.snapshot.customInstruction).toBe(agent?.customInstruction);
  });

  it("keeps a mixed agent update and its draft projection in one generation", async () => {
    const agentId = await createAgentWithDraft();

    const saved = await agents.update(agentId, workspaceId, {
      name: "Renamed with a draft instruction",
      customInstruction: "Use the revised answer policy.",
    });

    expect(saved).toMatchObject({
      name: "Renamed with a draft instruction",
      customInstruction: "Use the revised answer policy.",
    });
    await expect(revisions.readDraft(workspaceId, agentId)).resolves.toMatchObject({
      generation: 2,
      snapshot: { customInstruction: "Use the revised answer policy." },
    });
  });

  it("keeps context enablement storage and the draft in sync across save, reload, and concurrent writes", async () => {
    const agentId = await createAgentWithDraft();
    const variable = await contextVariables.create({
      workspaceId,
      name: `context-${agentId}`,
      description: null,
      valueType: "string",
      trustTier: "signed",
      sensitivity: "normal",
      defaultSurfacing: "always",
    });
    const saved = await contextVariables.upsertEnablement({
      agentId,
      variableId: variable.id,
      source: "pushed",
      surfacing: "always",
      enabled: true,
    });
    const { variable: _savedVariable, ...savedSnapshot } = saved;
    const [savedReload] = await contextVariables.listByAgent(workspaceId, agentId);
    const { variable: _savedReloadVariable, ...savedReloadSnapshot } = savedReload;
    expect(savedReloadSnapshot).toEqual(savedSnapshot);
    expect(await revisions.readDraft(workspaceId, agentId)).toMatchObject({
      generation: 2,
      snapshot: { contextVariableEnablements: [savedSnapshot] },
    });

    const candidate = await revisions.createCandidate(workspaceId, agentId, {
      id: randomUUID(),
      expectedDraftGeneration: 2,
    });
    if (candidate === "conflict") throw new Error("candidate unexpectedly conflicted");

    await Promise.all([
      contextVariables.upsertEnablement({ agentId, variableId: variable.id, source: "browser", surfacing: "on_reference", enabled: true }),
      contextVariables.upsertEnablement({ agentId, variableId: variable.id, source: "pushed", surfacing: "operator_only", enabled: false }),
    ]);
    const [reloaded] = await contextVariables.listByAgent(workspaceId, agentId);
    const { variable: _reloadedVariable, ...reloadedSnapshot } = reloaded;
    const draft = await revisions.readDraft(workspaceId, agentId);
    expect(draft?.generation).toBe(4);
    expect(draft?.snapshot.contextVariableEnablements).toEqual([reloadedSnapshot]);
    expect(candidate.snapshot.contextVariableEnablements).toEqual([savedSnapshot]);

    await expect(
      contextVariables.applyProposal({
        workspaceId,
        agentId,
        variableId: variable.id,
        definition: null,
        expectedVariableUpdatedAt: null,
        enablement: {
          source: "pushed",
          resolverSkillId: null,
          maxAgeSeconds: null,
          resolverTimeoutMs: null,
          surfacing: "always",
          enabled: true,
        },
        expectedEnablementUpdatedAt: null,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await contextVariables.listByAgent(workspaceId, agentId)).toEqual([reloaded]);
    await expect(revisions.readDraft(workspaceId, agentId)).resolves.toMatchObject({
      generation: 4,
      snapshot: { contextVariableEnablements: [reloadedSnapshot] },
    });

    await expect(contextVariables.deleteEnablement(agentId, randomUUID())).resolves.toBe(false);
    await expect(revisions.readDraft(workspaceId, agentId)).resolves.toMatchObject({ generation: 4 });
  });

  it("keeps the draft snapshot in sync as a routine is created, edited in place, and taken out of service", async () => {
    const agentId = await createAgentWithDraft();
    const service = new RoutineDefinitionService({ agentRepository: agents, repository: routines });
    const created = await service.createDraft(workspaceId, agentId, routineInput("v1"));
    expect((await revisions.readDraft(workspaceId, agentId))?.snapshot.routines).toMatchObject([
      { id: created.routine.id, enabled: true, steps: [{ instruction: "v1" }] },
    ]);

    const candidate = await revisions.createCandidate(workspaceId, agentId, {
      id: randomUUID(), expectedDraftGeneration: 2,
    });
    if (candidate === "conflict") throw new Error("candidate unexpectedly conflicted");

    // The agent revision system is the only publication boundary in the collapsed model, so
    // "delete" disabling rather than removing (below) must be earned by an actual publish, not by
    // having merely been touched since creation.
    const published = await revisions.publish({
      workspaceId, agentId, actorAccountId: null, revisionId: candidate.id,
      expectedDraftGeneration: 2, expectedPublishedRevisionId: null, idempotencyKey: randomUUID(),
    });
    if (published === "conflict" || published === "idempotency_mismatch") throw new Error(`publish unexpectedly ${published}`);

    // Editing rewrites the same row in place; the id never changes, so a directive scope
    // tag naming this routine never needs to be repointed.
    const updated = await service.updateDraft(workspaceId, agentId, created.routine.id, routineInput("v2"));
    expect(updated.routine.id).toBe(created.routine.id);
    expect((await revisions.readDraft(workspaceId, agentId))?.snapshot.routines).toMatchObject([
      { id: created.routine.id, enabled: true, steps: [{ instruction: "v2" }] },
    ]);
    expect(candidate.snapshot.routines).toMatchObject([
      { id: created.routine.id, steps: [{ instruction: "v1" }] },
    ]);

    await service.setEnabled(workspaceId, agentId, created.routine.id, false);
    expect((await revisions.readDraft(workspaceId, agentId))?.snapshot.routines).toMatchObject([
      { id: created.routine.id, enabled: false },
    ]);

    // The agent published a revision after this routine was created (above), so it could have
    // gone live: "delete" disables it in place rather than removing it, keeping findPinnedById
    // resolving for any in-flight conversation that reached it.
    await service.deleteDraft(workspaceId, agentId, created.routine.id);
    expect((await revisions.readDraft(workspaceId, agentId))?.snapshot.routines).toMatchObject([
      { id: created.routine.id, enabled: false },
    ]);
  });

  it("removes a routine outright from the draft snapshot when it was created disabled and never touched", async () => {
    const agentId = await createAgentWithDraft();
    const service = new RoutineDefinitionService({ agentRepository: agents, repository: routines });
    const created = await service.createDraft(workspaceId, agentId, { ...routineInput("never-served"), enabled: false });

    await service.deleteDraft(workspaceId, agentId, created.routine.id);

    expect((await revisions.readDraft(workspaceId, agentId))?.snapshot.routines).toEqual([]);
  });

  it("serializes a routine update with candidate materialization without exposing a partial graph", async () => {
    const agentId = await createAgentWithDraft();
    const service = new RoutineDefinitionService({ agentRepository: agents, repository: routines });
    const created = await service.createDraft(workspaceId, agentId, routineInput("before"));
    const [saved, candidate] = await Promise.all([
      service.updateDraft(workspaceId, agentId, created.routine.id, routineInput("after")),
      revisions.createCandidate(workspaceId, agentId, { id: randomUUID(), expectedDraftGeneration: 2 }),
    ]);
    const draft = await revisions.readDraft(workspaceId, agentId);
    expect(draft?.snapshot.routines).toEqual([saved.routine]);
    if (candidate !== "conflict") {
      expect(candidate.snapshot.routines).toEqual([created.routine]);
    }
  });

  it("keeps an incomplete routine draft saveable but rejects it as an immutable candidate", async () => {
    const agentId = await createAgentWithDraft();
    const service = new RoutineDefinitionService({ agentRepository: agents, repository: routines });
    const incomplete = routineInput("incomplete");
    incomplete.transitions = [{ ...incomplete.transitions[0], toRef: "missing_terminal" }];
    await service.createDraft(workspaceId, agentId, incomplete);
    await expect(revisions.createCandidate(workspaceId, agentId, {
      id: randomUUID(), expectedDraftGeneration: 2,
    })).rejects.toMatchObject({ statusCode: 422, code: "revision_invalid" });
    await expect(revisions.readDraft(workspaceId, agentId)).resolves.toMatchObject({ generation: 2 });
  });
});
