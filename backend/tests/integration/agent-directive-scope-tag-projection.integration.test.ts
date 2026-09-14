import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import { RoutineDefinitionService, type RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

// Real-Postgres coverage for the two release-time guarantees around a directive's
// `routine:<id>` / `step:<id>:<stepId>` scope tags, neither of which had any test reference
// before this file (confirmed by grepping tests/ for `projectDirectiveScopeTagsForSelectedRoutines`
// and `missing_scoped_routine`):
//
// 1. `assertCandidateSnapshotIsRunnable` (src/modules/agents/agentRevision.ts) blocks a candidate
//    whose directive scope tag names a routine or step the candidate's snapshot does not carry.
// 2. `projectDirectiveScopeTagsForSelectedRoutines` (src/modules/routines/draftProjection.ts),
//    run by `RoutineDefinitionRepository`'s `*WithAgentDraft` methods on every routine write,
//    repoints a directive's tag from a legacy, non-canonical lineage row onto the row the draft
//    snapshot actually selects — a no-op for anything authored since the routine-lifecycle
//    collapse, where a routine's id never changes across an edit.
const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const directiveInput = (name: string, tags: string[] = []) => ({
  name,
  condition: { kind: "always" as const },
  action: "Use a formal register.",
  tags,
});

const routineInput = (label: string): RoutineDefinitionDraftInput => ({
  name: `scope-tag-routine-${label}`,
  enabled: true,
  activation: { triggerDescription: `Run ${label}`, gateRef: null, priority: 1, reentryMode: "once_per_conversation" },
  slots: [],
  steps: [{ stableStepId: "step_one", kind: "chat", instruction: label, toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "step_one", toRef: "terminal_done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
  terminals: [{ stableStepId: "terminal_done", kind: "complete", instruction: "Done", ordinal: 1 }],
});

describeDb("agent directive scope-tag projection and release gate", () => {
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  let database: Database;
  let agents: AgentRepository;
  let revisions: AgentRevisionRepository;
  let routines: RoutineDefinitionRepository;
  let service: RoutineDefinitionService;

  const emptySnapshot = {
    customInstruction: null,
    directives: [],
    routines: [],
    contextVariableEnablements: [],
  };

  const createAgentWithDraft = async () => {
    const agentId = randomUUID();
    await database.query(
      "INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)",
      [agentId, workspaceId, `scope-tag-${agentId}`],
    );
    await database.query(
      "INSERT INTO agent_drafts (agent_id, workspace_id, generation, snapshot) VALUES ($1, $2, 1, $3::jsonb)",
      [agentId, workspaceId, JSON.stringify(emptySnapshot)],
    );
    return agentId;
  };

  /**
   * Writes a two-row lineage directly, the shape the retired publish/revise flow left behind
   * and that `seedLegacyLineage` in routine-definition-repository.integration.test.ts also
   * constructs by hand: nothing in the current application can produce more than one row per
   * lineage any more, so raw SQL is the only way to exercise the legacy-repointing path.
   */
  const seedLegacyLineage = async (input: {
    agentId: string;
    lineageId: string;
    name: string;
    versions: readonly { id: string; version: number; status: string }[];
  }): Promise<void> => {
    for (const version of input.versions) {
      await database.query(
        `INSERT INTO routine_definition (
           id, agent_id, lineage_id, version, name, status, enabled, activation_trigger_description, activation_priority
         )
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, 0)`,
        [version.id, input.agentId, input.lineageId, version.version, input.name, version.status, `Legacy ${input.name} v${version.version}`],
      );
      await database.query(
        `INSERT INTO routine_step (definition_id, stable_step_id, kind, instruction, ordinal)
         VALUES ($1, 'step_legacy', 'chat', $2, 0)`,
        [version.id, `Legacy step v${version.version}`],
      );
      await database.query(
        `INSERT INTO routine_terminal (definition_id, stable_step_id, kind, instruction, ordinal)
         VALUES ($1, 'term_legacy', 'complete', 'Legacy done', 0)`,
        [version.id],
      );
    }
  };

  beforeAll(async () => {
    database = new Database(url!);
    await runAllTestMigrations(database);
    agents = new AgentRepository(database.kysely);
    revisions = new AgentRevisionRepository(database.kysely);
    routines = new RoutineDefinitionRepository(database.kysely);
    service = new RoutineDefinitionService({ agentRepository: agents, repository: routines });
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "scope tag draft", `scope-tag-draft-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "scope tag draft", `scope-tag-draft-${workspaceId}`],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close();
  });

  it("blocks a candidate whose directive scope tag names a routine step that no longer exists", async () => {
    const agentId = await createAgentWithDraft();
    const created = await service.createDraft(workspaceId, agentId, routineInput("v1"));
    const directive = await agents.createDirective(
      agentId, workspaceId,
      directiveInput("step-scoped", [`step:${created.routine.id}:step_one`]),
    );

    // Editing rewrites the same routine row in place (its id never changes), but this edit
    // replaces "step_one" with a differently named step — the directive's tag now names a step
    // that does not exist on the row it still correctly addresses.
    await service.updateDraft(workspaceId, agentId, created.routine.id, {
      ...routineInput("v2"),
      steps: [{ stableStepId: "step_two", kind: "chat", instruction: "v2", toolRef: null, ordinal: 0, metadata: {} }],
      transitions: [{ fromStep: "step_two", toRef: "terminal_done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
    });

    const draft = await revisions.readDraft(workspaceId, agentId);
    if (!draft) throw new Error("expected a draft");

    await expect(
      revisions.createCandidate(workspaceId, agentId, { id: randomUUID(), expectedDraftGeneration: draft.generation }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "revision_invalid",
      details: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "missing_scoped_routine_step",
            location: `directive:${directive.id}`,
          }),
        ]),
      },
    });
  });

  it("leaves a directive's scope tag unchanged, and lets a candidate through, when the tagged routine still exists after an edit", async () => {
    const agentId = await createAgentWithDraft();
    const created = await service.createDraft(workspaceId, agentId, routineInput("steady-v1"));
    const directive = await agents.createDirective(
      agentId, workspaceId,
      directiveInput("routine-scoped", [`routine:${created.routine.id}`]),
    );

    // Same-id in-place edit: nothing for the directive's tag to repoint to.
    await service.updateDraft(workspaceId, agentId, created.routine.id, routineInput("steady-v2"));

    const draft = await revisions.readDraft(workspaceId, agentId);
    if (!draft) throw new Error("expected a draft");
    const draftDirective = draft.snapshot.directives.find((entry) => entry.id === directive.id);
    expect(draftDirective?.tags).toEqual([`routine:${created.routine.id}`]);

    const candidate = await revisions.createCandidate(workspaceId, agentId, { id: randomUUID(), expectedDraftGeneration: draft.generation });
    if (candidate === "conflict") throw new Error("candidate unexpectedly conflicted");
    const candidateDirective = candidate.snapshot.directives.find((entry) => entry.id === directive.id);
    expect(candidateDirective?.tags).toEqual([`routine:${created.routine.id}`]);
  });

  it("repoints a directive's scope tag from a legacy lineage's superseded row onto the row the draft actually selects", async () => {
    const agentId = await createAgentWithDraft();
    const lineageId = randomUUID();
    const supersededId = randomUUID();
    const canonicalId = randomUUID();
    await seedLegacyLineage({
      agentId,
      lineageId,
      name: "legacy-repoint",
      versions: [
        { id: supersededId, version: 1, status: "superseded" },
        { id: canonicalId, version: 2, status: "published" },
      ],
    });
    // Authored while the lineage's now-superseded row was still the one an authoring surface
    // held. Nothing rewrites this scope tag at the moment it is created — only a later routine
    // write's draft projection does.
    const directive = await agents.createDirective(
      agentId, workspaceId,
      directiveInput("legacy-scoped", [`routine:${supersededId}`]),
    );

    // Any routine write for this agent re-projects the whole draft, including directive scope
    // tags — reached here through the same *WithAgentDraft surface a normal edit uses, addressed
    // by the canonical row (an authoring surface reading the lineage today would only ever hold
    // this id).
    await routines.setEnabledWithAgentDraft(workspaceId, agentId, canonicalId, true);

    const draft = await revisions.readDraft(workspaceId, agentId);
    const projectedDirective = draft?.snapshot.directives.find((entry) => entry.id === directive.id);
    expect(projectedDirective?.tags).toEqual([`routine:${canonicalId}`]);

    // The live authored row is untouched — only the immutable draft view follows the lineage.
    const [liveDirective] = await agents.listDirectives(agentId, workspaceId);
    expect(liveDirective.tags).toEqual([`routine:${supersededId}`]);
  });
});
