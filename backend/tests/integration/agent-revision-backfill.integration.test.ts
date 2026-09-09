import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { equalScopedAuthoringSnapshots, parseAgentRevisionSnapshot } from "../../src/modules/agents/agentRevision.js";
import { createPublishedRoutineRegistrationSource } from "../../src/app/composition/routineDefinitionSource.js";
import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { legacyCompiledRoutineId } from "../../src/modules/routines/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { applyTestMigration, runTestMigrationsBefore } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("agent revision baseline migration", () => {
  let database: Database;
  let administrationDatabase: Database;
  let databaseName: string;

  beforeAll(async () => {
    databaseName = `radioso_agent_revision_backfill_${randomUUID().replaceAll("-", "")}`;
    const administrationUrl = new URL(url!);
    administrationUrl.pathname = "/postgres";
    administrationDatabase = new Database(administrationUrl.toString());
    await administrationDatabase.execute(`CREATE DATABASE "${databaseName}"`);
    const isolatedUrl = new URL(url!);
    isolatedUrl.pathname = `/${databaseName}`;
    database = new Database(isolatedUrl.toString());
    await runTestMigrationsBefore(database, "171_agent_draft_revisions.sql");
  }, 30_000);

  afterAll(async () => {
    await database.close();
    await administrationDatabase.execute(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await administrationDatabase.execute(`DROP DATABASE "${databaseName}"`);
    await administrationDatabase.close();
  });

  it("backfills an equivalent revision and supports consecutive candidates from its non-null baseline", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const variableId = randomUUID();
    const routineId = randomUUID();
    const savedRoutineId = randomUUID();
    const lineageId = randomUUID();
    const legacyConversationId = randomUUID();
    const newDraftAgentId = randomUUID();
    const newRoutineId = randomUUID();
    const newRoutineLineageId = randomUUID();
    const incompleteDraftAgentId = randomUUID();
    const incompleteRoutineId = randomUUID();
    const incompleteRoutineLineageId = randomUUID();
    const cleanAgentId = randomUUID();
    const cleanRoutineId = randomUUID();
    const cleanRoutineLineageId = randomUUID();
    const cleanSecondRoutineId = randomUUID();
    const cleanSecondRoutineLineageId = randomUUID();
    const pinnedAgentId = randomUUID();
    const pinnedPublishedRoutineId = randomUUID();
    const pinnedRetainedRoutineId = randomUUID();
    const pinnedRoutineLineageId = randomUUID();
    const pinnedConversationId = randomUUID();
    const legacyPinnedConversationId = randomUUID();
    const invalidPinnedConversationId = randomUUID();
    const missingPinnedConversationId = randomUUID();
    const missingRoutineId = randomUUID();
    const ambiguousAgentId = randomUUID();
    const ambiguousRoutineId = randomUUID();
    const ambiguousSecondRoutineId = randomUUID();
    const ambiguousRoutineLineageId = randomUUID();
    const ambiguousSecondRoutineLineageId = randomUUID();
    const ambiguousConversationId = randomUUID();
    const collisionAgentId = randomUUID();
    const collisionRetainedRoutineId = randomUUID();
    const collisionPublishedRoutineId = randomUUID();
    const collisionDraftRoutineId = randomUUID();
    const collisionRetainedLineageId = randomUUID();
    const collisionPublishedLineageId = randomUUID();
    const collisionDraftLineageId = randomUUID();
    const collisionConversationId = randomUUID();

    await database.query("INSERT INTO accounts (id,name,email,password_hash) VALUES ($1,$2,$3,$4)", [accountId, "Migration", `migration-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id,account_id,name,public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "Migration", `migration-${workspaceId}`]);
    await database.query("INSERT INTO agents (id,workspace_id,name,behavior_settings) VALUES ($1,$2,$3,$4::jsonb)", [agentId, workspaceId, "Agent", JSON.stringify({ customInstruction: "Preserve me" })]);
    await database.query("INSERT INTO conversations (id,workspace_id,agent_id) VALUES ($1,$2,$3)", [legacyConversationId, workspaceId, agentId]);
    await database.query("INSERT INTO agent_directives (id,agent_id,name,condition_kind,action,scope_tags) VALUES ($1,$2,$3,$4,$5,$6::text[])", [randomUUID(), agentId, "preserved", "always", "Keep this directive", [`routine:${routineId}`, `step:${routineId}:approve`]]);
    await database.query("INSERT INTO context_variables (id,workspace_id,name,value_type,trust_tier,sensitivity,default_surfacing) VALUES ($1,$2,$3,$4,$5,$6,$7)", [variableId, workspaceId, "visitor_name", "string", "unverified", "normal", "always"]);
    await database.query("INSERT INTO agent_context_variables (agent_id,variable_id,source,surfacing) VALUES ($1,$2,$3,$4)", [agentId, variableId, "pushed", "always"]);
    await database.query("INSERT INTO routine_definition (id,agent_id,lineage_id,version,name,status,activation_trigger_description) VALUES ($1,$2,$3,$4,$5,$6,$7)", [routineId, agentId, lineageId, 1, "preserved-routine", "published", "When someone asks for help"]);
    await database.query("INSERT INTO routine_slot (definition_id,stable_slot_id,key,type,required,description,mutable,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [routineId, "order_id", "order_id", "text", true, "Order to approve", true, 0]);
    await database.query("INSERT INTO routine_step (definition_id,stable_step_id,kind,instruction,ordinal,capture_key,options) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)", [routineId, "approve", "approval", "Approve the refund for {{slot.order_id}}", 0, "refund_decision", JSON.stringify([{ id: "approve", label: "Approve", description: null }, { id: "reject", label: "Reject", description: null }])]);
    await database.query("INSERT INTO routine_terminal (definition_id,stable_step_id,kind,instruction,ordinal) VALUES ($1,$2,$3,$4,$5)", [routineId, "done", "complete", "Finish", 1]);
    await database.query("INSERT INTO routine_transition (definition_id,from_step,to_ref,guard_kind,field_ref,field_op,field_value,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8),($1,$2,$3,$4,$5,$6,$9::jsonb,$10)", [routineId, "approve", "done", "field", "refund_decision.id", "equals", JSON.stringify("approve"), 0, JSON.stringify("reject"), 1]);
    await database.query("INSERT INTO routine_definition (id,agent_id,lineage_id,version,name,status,activation_trigger_description) VALUES ($1,$2,$3,$4,$5,$6,$7)", [savedRoutineId, agentId, lineageId, 2, "preserved-routine", "draft", "When someone asks for help"]);
    await database.query("INSERT INTO routine_slot (definition_id,stable_slot_id,key,type,required,description,mutable,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [savedRoutineId, "order_id", "order_id", "text", true, "Order to approve", true, 0]);
    await database.query("INSERT INTO routine_step (definition_id,stable_step_id,kind,instruction,ordinal,capture_key,options) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)", [savedRoutineId, "approve", "approval", "Approve the revised refund for {{slot.order_id}}", 0, "refund_decision", JSON.stringify([{ id: "approve", label: "Approve", description: null }, { id: "reject", label: "Reject", description: null }])]);
    await database.query("INSERT INTO routine_terminal (definition_id,stable_step_id,kind,instruction,ordinal) VALUES ($1,$2,$3,$4,$5)", [savedRoutineId, "done", "complete", "Finish", 1]);
    await database.query("INSERT INTO routine_transition (definition_id,from_step,to_ref,guard_kind,field_ref,field_op,field_value,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8),($1,$2,$3,$4,$5,$6,$9::jsonb,$10)", [savedRoutineId, "approve", "done", "field", "refund_decision.id", "equals", JSON.stringify("approve"), 0, JSON.stringify("reject"), 1]);

    // The current constraint prevents duplicate legacy compiled ids. An isolated
    // historical-corruption fixture still verifies that migration 171 records
    // ambiguity rather than attaching a conversation to an arbitrary revision.
    await database.query("ALTER TABLE routine_definition DROP CONSTRAINT routine_definition_agent_id_name_version_key");

    const insertRoutine = async (input: { agentId: string; id: string; lineageId: string; version: number; status: "draft" | "published" | "superseded" | "archived"; name: string; instruction: string; transitionTarget?: string; priority?: number }) => {
      await database.query("INSERT INTO routine_definition (id,agent_id,lineage_id,version,name,status,activation_trigger_description,activation_priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [input.id, input.agentId, input.lineageId, input.version, input.name, input.status, "Run this routine", input.priority ?? 0]);
      await database.query("INSERT INTO routine_step (definition_id,stable_step_id,kind,instruction,ordinal) VALUES ($1,$2,$3,$4,$5)", [input.id, "collect", "chat", input.instruction, 0]);
      await database.query("INSERT INTO routine_terminal (definition_id,stable_step_id,kind,instruction,ordinal) VALUES ($1,$2,$3,$4,$5)", [input.id, "done", "complete", "Finish", 1]);
      await database.query("INSERT INTO routine_transition (definition_id,from_step,to_ref,guard_kind,ordinal) VALUES ($1,$2,$3,$4,$5)", [input.id, "collect", input.transitionTarget ?? "done", "default", 0]);
    };
    for (const [id, name] of [[newDraftAgentId, "new routine authoring"], [incompleteDraftAgentId, "incomplete routine authoring"], [cleanAgentId, "clean routine baseline"], [pinnedAgentId, "pinned routine baseline"], [ambiguousAgentId, "ambiguous routine pin"], [collisionAgentId, "draft collision routine pin"]]) {
      await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [id, workspaceId, name]);
    }
    await insertRoutine({ agentId: newDraftAgentId, id: newRoutineId, lineageId: newRoutineLineageId, version: 1, status: "draft", name: "new saved", instruction: "new saved routine" });
    await insertRoutine({ agentId: incompleteDraftAgentId, id: incompleteRoutineId, lineageId: incompleteRoutineLineageId, version: 1, status: "draft", name: "incomplete saved", instruction: "incomplete saved routine", transitionTarget: "missing_terminal" });
    await insertRoutine({ agentId: cleanAgentId, id: cleanRoutineId, lineageId: cleanRoutineLineageId, version: 1, status: "published", name: "clean published", instruction: "clean published routine", priority: 1 });
    await insertRoutine({ agentId: cleanAgentId, id: cleanSecondRoutineId, lineageId: cleanSecondRoutineLineageId, version: 1, status: "published", name: "clean published second", instruction: "clean published second routine", priority: 9 });
    await insertRoutine({ agentId: pinnedAgentId, id: pinnedRetainedRoutineId, lineageId: pinnedRoutineLineageId, version: 1, status: "superseded", name: "pinned routine", instruction: "retained v1" });
    await insertRoutine({ agentId: pinnedAgentId, id: pinnedPublishedRoutineId, lineageId: pinnedRoutineLineageId, version: 2, status: "published", name: "pinned routine", instruction: "published v2" });
    await insertRoutine({ agentId: ambiguousAgentId, id: ambiguousRoutineId, lineageId: ambiguousRoutineLineageId, version: 1, status: "superseded", name: "ambiguous", instruction: "first ambiguous" });
    await insertRoutine({ agentId: ambiguousAgentId, id: ambiguousSecondRoutineId, lineageId: ambiguousSecondRoutineLineageId, version: 1, status: "archived", name: "ambiguous", instruction: "second ambiguous" });
    await insertRoutine({ agentId: collisionAgentId, id: collisionRetainedRoutineId, lineageId: collisionRetainedLineageId, version: 1, status: "superseded", name: "collision", instruction: "retained collision" });
    await insertRoutine({ agentId: collisionAgentId, id: collisionPublishedRoutineId, lineageId: collisionPublishedLineageId, version: 2, status: "published", name: "collision", instruction: "published collision" });
    await insertRoutine({ agentId: collisionAgentId, id: collisionDraftRoutineId, lineageId: collisionDraftLineageId, version: 1, status: "draft", name: "collision", instruction: "private collision" });
    await database.query("INSERT INTO conversations (id,workspace_id,agent_id) VALUES ($1,$2,$3),($4,$2,$3),($5,$2,$3),($6,$2,$3),($7,$2,$8),($9,$2,$10)", [pinnedConversationId, workspaceId, pinnedAgentId, legacyPinnedConversationId, invalidPinnedConversationId, missingPinnedConversationId, ambiguousConversationId, ambiguousAgentId, collisionConversationId, collisionAgentId]);
    const legacyPinnedRoutineId = `routine:${pinnedAgentId}:pinned routine:v1`;
    const ambiguousRoutinePin = `routine:${ambiguousAgentId}:ambiguous:v1`;
    await database.query("INSERT INTO routine_states (session_id,routine_id,path,variables,attempts,status) VALUES ($1,$2,$3::text[],$4::jsonb,$5::jsonb,$6),($7,$8,$3::text[],$4::jsonb,$5::jsonb,$6),($9,$10,$3::text[],$4::jsonb,$5::jsonb,$6),($11,$12,$3::text[],$4::jsonb,$5::jsonb,$6),($13,$14,$3::text[],$4::jsonb,$5::jsonb,$6),($15,$16,$3::text[],$4::jsonb,$5::jsonb,$6)", [pinnedConversationId, pinnedRetainedRoutineId, ["collect"], JSON.stringify({}), JSON.stringify({}), "active", legacyPinnedConversationId, legacyPinnedRoutineId, invalidPinnedConversationId, "invalid-pin", missingPinnedConversationId, missingRoutineId, ambiguousConversationId, ambiguousRoutinePin, collisionConversationId, `routine:${collisionAgentId}:collision:v1`]);

    await applyTestMigration(database, "171_agent_draft_revisions.sql");
    const rows = await database.query<{ snapshot: unknown; published_revision_id: string | null }>("SELECT d.snapshot, a.published_revision_id FROM agent_drafts d JOIN agents a ON a.id=d.agent_id WHERE d.agent_id=$1", [agentId]);
    const row = rows[0];
    expect(row?.published_revision_id).toEqual(expect.any(String));
    const snapshot = parseAgentRevisionSnapshot(row?.snapshot);
    expect(snapshot.customInstruction).toBe("Preserve me");
    expect(snapshot.directives).toHaveLength(1);
    expect(snapshot.routines).toHaveLength(1);
    expect(snapshot.routines[0]).toMatchObject({ id: savedRoutineId, status: "draft", slots: [{ stableSlotId: "order_id", mutable: true }], steps: [{ stableStepId: "approve", kind: "approval", captureKey: "refund_decision", options: [{ id: "approve" }, { id: "reject" }] }] });
    expect(snapshot.directives[0]?.tags).toEqual([`routine:${savedRoutineId}`, `step:${savedRoutineId}:approve`]);
    expect(snapshot.contextVariableEnablements.map((enablement) => enablement.variableId)).toEqual([variableId]);

    const baselineRevisionId = row?.published_revision_id;
    if (!baselineRevisionId) throw new Error("Expected migration baseline revision");
    const [baselineRow] = await database.query<{ snapshot: unknown }>("SELECT snapshot FROM agent_revisions WHERE workspace_id=$1 AND agent_id=$2 AND id=$3", [workspaceId, agentId, baselineRevisionId]);
    const baselineSnapshot = parseAgentRevisionSnapshot(baselineRow?.snapshot);
    expect(baselineSnapshot.routines).toMatchObject([{ id: routineId, status: "published", slots: [{ stableSlotId: "order_id", mutable: true }], steps: [{ stableStepId: "approve", kind: "approval", captureKey: "refund_decision", options: [{ id: "approve" }, { id: "reject" }] }] }]);
    expect(baselineSnapshot.directives[0]?.tags).toEqual([`routine:${routineId}`, `step:${routineId}:approve`]);
    expect(await database.query("SELECT agent_revision_id FROM conversations WHERE id=$1", [legacyConversationId]))
      .toEqual([{ agent_revision_id: baselineRevisionId }]);

    // This fixture intentionally begins on the pre-171 schema. The current
    // repository reads the release-number column introduced by 178, so add that
    // later migration only after the historical 171 assertions above.
    await applyTestMigration(database, "178_agent_revision_published_versions.sql");
    const revisions = new AgentRevisionRepository(database.kysely);
    expect((await revisions.readState(workspaceId, agentId))?.status).toBe("draft_dirty");

    const newDraft = await revisions.readDraft(workspaceId, newDraftAgentId);
    expect(newDraft?.snapshot.routines).toMatchObject([{ id: newRoutineId, status: "draft" }]);
    await expect(revisions.createCandidate(workspaceId, newDraftAgentId, { id: randomUUID(), expectedDraftGeneration: newDraft!.generation }))
      .resolves.not.toBe("conflict");
    const incompleteDraft = await revisions.readDraft(workspaceId, incompleteDraftAgentId);
    expect(incompleteDraft?.snapshot.routines).toMatchObject([{ id: incompleteRoutineId, transitions: [{ toRef: "missing_terminal" }] }]);
    await expect(revisions.createCandidate(workspaceId, incompleteDraftAgentId, {
      id: randomUUID(), expectedDraftGeneration: incompleteDraft!.generation,
    })).rejects.toMatchObject({ statusCode: 422, code: "revision_invalid" });
    expect((await revisions.readDraft(workspaceId, incompleteDraftAgentId))?.snapshot.routines).toMatchObject([{ id: incompleteRoutineId }]);
    const cleanDraft = await revisions.readDraft(workspaceId, cleanAgentId);
    const cleanPublishedId = (await database.query<{ published_revision_id: string | null }>("SELECT published_revision_id FROM agents WHERE id=$1", [cleanAgentId]))[0]?.published_revision_id;
    if (!cleanDraft || !cleanPublishedId) throw new Error("Expected clean routine baseline");
    const cleanPublished = await revisions.findRevision(workspaceId, cleanAgentId, cleanPublishedId);
    if (!cleanPublished) throw new Error("Expected clean published revision");
    expect(equalScopedAuthoringSnapshots(cleanDraft.snapshot, cleanPublished.snapshot)).toBe(true);
    expect((await revisions.readState(workspaceId, cleanAgentId))?.status).toBe("draft_clean");

    const pinnedRevisionId = (await database.query<{ agent_revision_id: string | null }>("SELECT agent_revision_id FROM conversations WHERE id=$1", [pinnedConversationId]))[0]?.agent_revision_id;
    if (!pinnedRevisionId) throw new Error("Expected safe active routine conversation binding");
    const pinnedRevision = await revisions.findRevision(workspaceId, pinnedAgentId, pinnedRevisionId);
    expect(pinnedRevision?.snapshot.routines).toMatchObject([{ id: pinnedPublishedRoutineId, status: "published" }]);
    expect(pinnedRevision?.snapshot).toMatchObject({ retainedRoutineDefinitions: [{ id: pinnedRetainedRoutineId, status: "superseded", steps: [{ instruction: "retained v1" }] }] });
    expect((await revisions.readState(workspaceId, pinnedAgentId))?.status).toBe("draft_clean");
    expect(await database.query("SELECT agent_revision_id FROM conversations WHERE id=$1", [legacyPinnedConversationId]))
      .toEqual([{ agent_revision_id: pinnedRevisionId }]);
    expect(await database.query("SELECT agent_revision_id FROM conversations WHERE id=$1", [invalidPinnedConversationId]))
      .toEqual([{ agent_revision_id: null }]);
    expect(await database.query("SELECT classification FROM agent_revision_migration_classifications WHERE conversation_id=$1", [invalidPinnedConversationId]))
      .toEqual([{ classification: "invalid_routine_pin" }]);
    expect(await database.query("SELECT agent_revision_id FROM conversations WHERE id=$1", [missingPinnedConversationId]))
      .toEqual([{ agent_revision_id: null }]);
    expect(await database.query("SELECT classification FROM agent_revision_migration_classifications WHERE conversation_id=$1", [missingPinnedConversationId]))
      .toEqual([{ classification: "missing_routine_definition" }]);
    expect(await database.query("SELECT agent_revision_id FROM conversations WHERE id=$1", [ambiguousConversationId]))
      .toEqual([{ agent_revision_id: null }]);
    expect(await database.query("SELECT classification FROM agent_revision_migration_classifications WHERE conversation_id=$1", [ambiguousConversationId]))
      .toEqual([{ classification: "ambiguous_routine_definition" }]);
    const collisionPublishedId = (await database.query<{ published_revision_id: string | null }>("SELECT published_revision_id FROM agents WHERE id=$1", [collisionAgentId]))[0]?.published_revision_id;
    if (!collisionPublishedId) throw new Error("Expected collision baseline revision");
    const collisionRevision = await revisions.findRevision(workspaceId, collisionAgentId, collisionPublishedId);
    expect(collisionRevision?.snapshot.retainedRoutineDefinitions).toMatchObject([{ id: collisionRetainedRoutineId }]);
    expect(collisionRevision?.snapshot.retainedRoutineDefinitions).not.toMatchObject([{ id: collisionDraftRoutineId }]);
    await database.query("DELETE FROM routine_definition WHERE id=$1", [pinnedRetainedRoutineId]);
    const source = createPublishedRoutineRegistrationSource({
      listPublishedByAgent: async () => { throw new Error("mutable routine lookup is forbidden"); },
      listByAgent: async () => { throw new Error("mutable routine lookup is forbidden"); },
      findPinnedById: async () => { throw new Error("mutable routine lookup is forbidden"); },
      findById: async () => { throw new Error("mutable routine lookup is forbidden"); },
    }, { revisionReader: { findRevision: async () => pinnedRevision } });
    expect((await source.load({ agentId: pinnedAgentId, workspaceId, agentRevisionId: pinnedRevisionId })).map((registration) => registration.routine.id))
      .toEqual([pinnedPublishedRoutineId]);
    expect((await source.loadPinned({ agentId: pinnedAgentId, workspaceId, agentRevisionId: pinnedRevisionId, routineIds: [pinnedRetainedRoutineId] })).map((registration) => registration.routine.id))
      .toEqual([pinnedRetainedRoutineId]);
    const retained = pinnedRevision?.snapshot.retainedRoutineDefinitions?.[0];
    if (!retained) throw new Error("Expected retained routine definition");
    expect(legacyCompiledRoutineId(retained)).toBe(legacyPinnedRoutineId);
    await expect(source.loadPinned({ agentId: pinnedAgentId, workspaceId, agentRevisionId: pinnedRevisionId, routineIds: [legacyCompiledRoutineId(retained)] }))
      .resolves.toMatchObject([{ routine: { id: legacyCompiledRoutineId(retained) } }]);

    const alreadyPinnedConversationId = randomUUID();
    await database.query("INSERT INTO conversations (id,workspace_id,agent_id,agent_revision_id) VALUES ($1,$2,$3,$4)", [alreadyPinnedConversationId, workspaceId, agentId, baselineRevisionId]);
    const firstEditedDraft = await revisions.mutateDraft(workspaceId, agentId, (draft) => ({
      ...draft,
      customInstruction: "First post-backfill release",
    }));
    if (!firstEditedDraft) throw new Error("Expected backfilled draft");
    const firstCandidate = await revisions.createCandidate(workspaceId, agentId, {
      id: randomUUID(),
      expectedDraftGeneration: firstEditedDraft.generation,
    });
    if (firstCandidate === "conflict") throw new Error("Expected first candidate from backfilled baseline");
    await expect(revisions.publish({
      workspaceId,
      agentId,
      actorAccountId: accountId,
      revisionId: firstCandidate.id,
      expectedDraftGeneration: firstEditedDraft.generation,
      expectedPublishedRevisionId: baselineRevisionId,
      idempotencyKey: "first-post-backfill-publication",
    })).resolves.toMatchObject({ revisionId: firstCandidate.id, idempotentReplay: false });

    const secondEditedDraft = await revisions.mutateDraft(workspaceId, agentId, (draft) => ({
      ...draft,
      customInstruction: "Second post-backfill release",
    }));
    if (!secondEditedDraft) throw new Error("Expected first publication draft");
    const secondCandidate = await revisions.createCandidate(workspaceId, agentId, {
      id: randomUUID(),
      expectedDraftGeneration: secondEditedDraft.generation,
    });
    const reusedSecondCandidate = await revisions.createCandidate(workspaceId, agentId, {
      id: randomUUID(),
      expectedDraftGeneration: secondEditedDraft.generation,
    });
    if (secondCandidate === "conflict" || reusedSecondCandidate === "conflict") {
      throw new Error("Expected second candidate from first published revision");
    }
    expect(reusedSecondCandidate.id).toBe(secondCandidate.id);
    expect(secondCandidate.sourceBasePublishedRevisionId).toBe(firstCandidate.id);
    await expect(revisions.publish({
      workspaceId,
      agentId,
      actorAccountId: accountId,
      revisionId: secondCandidate.id,
      expectedDraftGeneration: secondEditedDraft.generation,
      expectedPublishedRevisionId: firstCandidate.id,
      idempotencyKey: "second-post-backfill-publication",
    })).resolves.toMatchObject({ revisionId: secondCandidate.id, idempotentReplay: false });
    expect(await database.query("SELECT agent_revision_id FROM conversations WHERE id IN ($1,$2) ORDER BY id", [legacyConversationId, alreadyPinnedConversationId]))
      .toEqual([{ agent_revision_id: baselineRevisionId }, { agent_revision_id: baselineRevisionId }]);
  });

});
