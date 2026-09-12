import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/shared/infra/database.js";
import { parseAgentRevisionSnapshot } from "../../src/modules/agents/agentRevision.js";
import {
  applyTestMigration,
  runTestMigrationsBefore,
} from "../support/databaseMigrations.js";

// Regression guard for the migration-183 promotion fix. The bug it pins: migration 181 disables
// a lineage's canonical (highest-version) row whenever it is not published, but every read in
// this branch's collapsed model only ever looks at that single top row. For a lineage shaped
// v1 superseded / v2 published (content that was actually serving traffic) / v3 draft
// (an "Edit revision" started pre-cutover and abandoned), 181 correctly disables v3 but v3 stays
// canonical — the routine goes permanently dark and v2's actually-serving content becomes
// unaddressable through any canonical-row query. Migration 183 promotes v2's full content
// (including real steps/slots/transitions, not empty stubs) into a new v4 row so canonical
// selection recovers it.
//
// Needs CREATE DATABASE on the integration server; skips cleanly when no database is reachable.
const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const migration181 = "181_routine_definition_enabled.sql";
const migration182 = "182_webhook_destination_delete_gate_enabled.sql";
const migration183 = "183_routine_definition_promote_stranded_published_content.sql";
const migration185 = "185_reproject_agent_draft_routines_after_lifecycle_collapse.sql";

const canCreateIsolatedDatabase = async (databaseUrl?: string): Promise<boolean> => {
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

const isolatedDatabaseUrl = (baseUrl: string, databaseName: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const hasReachableDatabase = await canCreateIsolatedDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableDatabase ? describe : describe.skip;

describeIfDatabase("routine definition promote stranded published content migration (183)", () => {
  const isolatedName = `mig183_${randomUUID().replace(/-/g, "")}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${isolatedName}"`);
    database = new Database(isolatedDatabaseUrl(integrationDatabaseUrl!, isolatedName));
    await runTestMigrationsBefore(database, migration181);
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    if (admin) {
      await admin.execute(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => undefined);
      await admin.close().catch(() => undefined);
    }
  });

  it("recovers a lineage's actually-served content after an abandoned draft strands it, and leaves a pure-never-published lineage merely disabled", async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const strandedLineageId = randomUUID();
    const neverPublishedLineageId = randomUUID();

    await database.execute(
      "INSERT INTO accounts(id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')",
      [accountId, `mig183-${accountId}@example.com`],
    );
    await database.execute(
      "INSERT INTO workspaces(id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)",
      [workspaceId, accountId, `rk-${workspaceId}`],
    );
    await database.execute(
      "INSERT INTO agents(id, workspace_id, name) VALUES ($1, $2, 'Agent')",
      [agentId, workspaceId],
    );

    // v1 superseded (empty stub, irrelevant to the assertion), v2 published — real steps/slots/
    // transitions/terminals, the content that was actually serving traffic — v3 draft, abandoned
    // pre-cutover, never published. v3 is the canonical row today.
    const v1Id = randomUUID();
    const v2Id = randomUUID();
    const v3Id = randomUUID();
    await database.execute(
      `INSERT INTO routine_definition(id, agent_id, lineage_id, version, name, status, activation_trigger_description, activation_priority)
       VALUES ($1, $2, $3, 1, 'callback-request', 'superseded', 'Old trigger text', 0)`,
      [v1Id, agentId, strandedLineageId],
    );
    await database.execute(
      `INSERT INTO routine_definition(id, agent_id, lineage_id, version, name, status, activation_trigger_description, activation_priority)
       VALUES ($1, $2, $3, 2, 'callback-request', 'published', 'When the user asks to be called back', 7)`,
      [v2Id, agentId, strandedLineageId],
    );
    await database.execute(
      `INSERT INTO routine_slot(definition_id, stable_slot_id, key, type, required, description, ordinal)
       VALUES ($1, 'slot_phone', 'phone', 'text', true, 'Phone number', 0)`,
      [v2Id],
    );
    await database.execute(
      `INSERT INTO routine_step(definition_id, stable_step_id, kind, instruction, ordinal)
       VALUES ($1, 'step_ask', 'chat', 'Ask for a phone number', 0)`,
      [v2Id],
    );
    await database.execute(
      `INSERT INTO routine_step(definition_id, stable_step_id, kind, instruction, ordinal)
       VALUES ($1, 'step_done', 'chat', 'Confirm the callback request', 1)`,
      [v2Id],
    );
    await database.execute(
      `INSERT INTO routine_transition(definition_id, from_step, to_ref, guard_kind, ordinal)
       VALUES ($1, 'step_ask', 'step_done', 'slot_filled', 0)`,
      [v2Id],
    );
    await database.execute(
      `INSERT INTO routine_terminal(definition_id, stable_step_id, kind, instruction, ordinal)
       VALUES ($1, 'terminal_done', 'complete', 'Callback scheduled', 2)`,
      [v2Id],
    );
    await database.execute(
      `INSERT INTO routine_definition(id, agent_id, lineage_id, version, name, status, activation_trigger_description)
       VALUES ($1, $2, $3, 3, 'callback-request', 'draft', 'Abandoned edit, never finished publishing')`,
      [v3Id, agentId, strandedLineageId],
    );
    // The agent-draft baseline migration chose the abandoned v3 as this lineage's editable
    // draft. Keep both a stale candidate and an immutable revision to prove 185 fences the
    // former without rewriting released history.
    const staleCandidateId = randomUUID();
    const frozenRevisionId = randomUUID();
    const staleRoutineSnapshot = {
      id: v3Id, agentId, lineageId: strandedLineageId, version: 3, status: "draft",
      name: "callback-request", activation: { triggerDescription: "Abandoned edit, never finished publishing", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
      slots: [], steps: [], transitions: [], terminals: [], completionExport: { enabled: false, triggerKinds: [], destinationRef: "" },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const retainedRoutineSnapshot = {
      ...staleRoutineSnapshot,
      id: randomUUID(),
      slots: [],
      steps: [{ stableStepId: "retained_ask", kind: "chat", instruction: "Keep serving this pinned routine.", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
      transitions: [{ fromStep: "retained_ask", toRef: "retained_done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 }],
      terminals: [{ stableStepId: "retained_done", kind: "complete", instruction: "Done.", ordinal: 0 }],
    };
    const staleSnapshot = {
      customInstruction: "preserve this",
      directives: [{
        id: randomUUID(), agentId, name: "Scoped direction", condition: { kind: "always" }, action: "Follow the routine.", priority: null,
        requiredCapabilities: [], dependsOn: [], excludes: [], routes: [], surfaces: [],
        tags: [`routine:${v3Id}`, `step:${v3Id}:step_ask`, `routine:${"a".repeat(36)}`], description: null,
        binding: null, lifecycle: null, enabled: true, metadata: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
      routines: [staleRoutineSnapshot], retainedRoutineDefinitions: [retainedRoutineSnapshot], contextVariableEnablements: [],
    };
    await database.execute(
      "INSERT INTO agent_drafts(agent_id, workspace_id, generation, snapshot) VALUES ($1, $2, 7, $3)",
      [agentId, workspaceId, JSON.stringify(staleSnapshot)],
    );
    await database.execute(
      "INSERT INTO agent_revisions(id, agent_id, workspace_id, snapshot, source_draft_generation) VALUES ($1, $2, $3, $4, 7)",
      [frozenRevisionId, agentId, workspaceId, JSON.stringify(staleSnapshot)],
    );
    await database.execute(
      "INSERT INTO agent_revisions(id, agent_id, workspace_id, snapshot, source_draft_generation) VALUES ($1, $2, $3, $4, 7)",
      [staleCandidateId, agentId, workspaceId, JSON.stringify(staleSnapshot)],
    );

    // A pure never-published lineage: single draft row, nothing beneath it was ever published.
    // Nothing to promote — it must simply stay disabled by 181, with no new row created.
    const neverPublishedId = randomUUID();
    await database.execute(
      `INSERT INTO routine_definition(id, agent_id, lineage_id, version, name, status, activation_trigger_description)
       VALUES ($1, $2, $3, 1, 'unfinished-routine', 'draft', 'Never finished authoring')`,
      [neverPublishedId, agentId, neverPublishedLineageId],
    );
    await database.execute(
      "INSERT INTO routine_step(definition_id, stable_step_id, kind, instruction, ordinal) VALUES ($1, 'unfinished_ask', 'chat', 'Draft question', 0)",
      [neverPublishedId],
    );
    await database.execute(
      "INSERT INTO routine_terminal(definition_id, stable_step_id, kind, instruction, ordinal) VALUES ($1, 'unfinished_done', 'complete', 'Draft done', 1)",
      [neverPublishedId],
    );

    await applyTestMigration(database, migration181);

    // Confirm the bug exists at this point: the canonical row (v3) is disabled, but it is still
    // the ONLY row the app's canonical-row queries would return — v2's content is stranded.
    const afterBackfill = await database.query<{ version: number; enabled: boolean }>(
      "SELECT version, enabled FROM routine_definition WHERE lineage_id = $1 ORDER BY version DESC LIMIT 1",
      [strandedLineageId],
    );
    expect(afterBackfill[0]).toEqual(expect.objectContaining({ version: 3, enabled: false }));

    await applyTestMigration(database, migration182);
    await expect(applyTestMigration(database, migration183)).resolves.not.toThrow();

    // The stranded lineage now has a v4 row: promoted from v2's content, published, enabled.
    const strandedRows = await database.query<{ version: number; status: string; enabled: boolean }>(
      "SELECT version, status, enabled FROM routine_definition WHERE lineage_id = $1 ORDER BY version",
      [strandedLineageId],
    );
    expect(strandedRows).toEqual([
      expect.objectContaining({ version: 1, status: "superseded", enabled: true }),
      // v2 gets a live successor (v4) below, so it now reads as superseded rather than
      // published — the same status every other row a lineage has moved past already carries,
      // and required so idx_routine_definition_one_published_per_lineage stays satisfied.
      expect.objectContaining({ version: 2, status: "superseded", enabled: true }),
      expect.objectContaining({ version: 3, status: "draft", enabled: false }),
      expect.objectContaining({ version: 4, status: "published", enabled: true }),
    ]);

    const [canonical] = await database.query<{
      id: string;
      activation_trigger_description: string;
      activation_priority: number;
    }>(
      "SELECT id, activation_trigger_description, activation_priority FROM routine_definition WHERE lineage_id = $1 AND version = 4",
      [strandedLineageId],
    );
    // Content matches what v2 actually held — not v3's abandoned content.
    expect(canonical.activation_trigger_description).toBe("When the user asks to be called back");
    expect(canonical.activation_priority).toBe(7);

    const promotedSlots = await database.query<{ key: string; description: string }>(
      "SELECT key, description FROM routine_slot WHERE definition_id = $1",
      [canonical.id],
    );
    expect(promotedSlots).toEqual([expect.objectContaining({ key: "phone", description: "Phone number" })]);

    const promotedSteps = await database.query<{ stable_step_id: string; instruction: string }>(
      "SELECT stable_step_id, instruction FROM routine_step WHERE definition_id = $1 ORDER BY ordinal",
      [canonical.id],
    );
    expect(promotedSteps).toEqual([
      expect.objectContaining({ stable_step_id: "step_ask", instruction: "Ask for a phone number" }),
      expect.objectContaining({ stable_step_id: "step_done", instruction: "Confirm the callback request" }),
    ]);

    const promotedTransitions = await database.query<{ from_step: string; to_ref: string; guard_kind: string }>(
      "SELECT from_step, to_ref, guard_kind FROM routine_transition WHERE definition_id = $1",
      [canonical.id],
    );
    expect(promotedTransitions).toEqual([
      expect.objectContaining({ from_step: "step_ask", to_ref: "step_done", guard_kind: "slot_filled" }),
    ]);

    await expect(applyTestMigration(database, migration185)).resolves.not.toThrow();
    const [repairedDraft] = await database.query<{ generation: number; snapshot: Record<string, unknown> }>(
      "SELECT generation, snapshot FROM agent_drafts WHERE agent_id = $1",
      [agentId],
    );
    expect(repairedDraft.generation).toBe(8);
    expect(repairedDraft.snapshot).toMatchObject({
      customInstruction: "preserve this",
      retainedRoutineDefinitions: [expect.objectContaining({ id: retainedRoutineSnapshot.id })],
      routines: expect.arrayContaining([expect.objectContaining({ id: canonical.id, version: 4, enabled: true, name: "callback-request" })]),
      directives: [expect.objectContaining({ tags: [`routine:${canonical.id}`, `step:${canonical.id}:step_ask`, `routine:${"a".repeat(36)}`] })],
    });
    const parsedDraft = parseAgentRevisionSnapshot(repairedDraft.snapshot);
    expect(parsedDraft.routines).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: canonical.id, enabled: true }),
      expect.objectContaining({ id: neverPublishedId, enabled: false }),
    ]));
    expect(parsedDraft.retainedRoutineDefinitions).toEqual([expect.objectContaining({ id: retainedRoutineSnapshot.id })]);
    // A candidate frozen against generation 7 cannot pass the repository's expected-generation
    // guard after the repair; a released revision is intentionally byte-for-byte untouched.
    const [draftGeneration] = await database.query<{ generation: number }>(
      "SELECT generation FROM agent_drafts WHERE agent_id = $1 AND generation = 7",
      [agentId],
    );
    expect(draftGeneration).toBeUndefined();
    const [frozenRevision] = await database.query<{ snapshot: Record<string, unknown> }>(
      "SELECT snapshot FROM agent_revisions WHERE id = $1",
      [frozenRevisionId],
    );
    expect(frozenRevision.snapshot).toEqual(staleSnapshot);

    // Empty collections are a valid draft and must survive the JSONB projection as arrays, not
    // SQL nulls (and therefore do not receive a spurious generation bump).
    const emptyAgentId = randomUUID();
    await database.execute(
      "INSERT INTO agents(id, workspace_id, name) VALUES ($1, $2, 'Empty draft agent')",
      [emptyAgentId, workspaceId],
    );
    await database.execute(
      "INSERT INTO agent_drafts(agent_id, workspace_id, generation, snapshot) VALUES ($1, $2, 5, $3)",
      [emptyAgentId, workspaceId, JSON.stringify({ customInstruction: "keep", directives: [], routines: [], contextVariableEnablements: [] })],
    );
    await expect(applyTestMigration(database, migration185)).resolves.not.toThrow();
    const [emptyDraft] = await database.query<{ generation: number; snapshot: { directives: unknown; routines: unknown } }>(
      "SELECT generation, snapshot FROM agent_drafts WHERE agent_id = $1",
      [emptyAgentId],
    );
    expect(emptyDraft).toEqual({
      generation: 5,
      snapshot: expect.objectContaining({ directives: [], routines: [] }),
    });
    const [idempotentDraft] = await database.query<{ generation: number }>(
      "SELECT generation FROM agent_drafts WHERE agent_id = $1",
      [agentId],
    );
    expect(idempotentDraft.generation).toBe(8);

    const promotedTerminals = await database.query<{ stable_step_id: string; instruction: string }>(
      "SELECT stable_step_id, instruction FROM routine_terminal WHERE definition_id = $1",
      [canonical.id],
    );
    expect(promotedTerminals).toEqual([
      expect.objectContaining({ stable_step_id: "terminal_done", instruction: "Callback scheduled" }),
    ]);

    // The abandoned draft (v3) is untouched: still disabled, still in history, content intact.
    const abandonedSteps = await database.query<{ stable_step_id: string }>(
      "SELECT stable_step_id FROM routine_step WHERE definition_id = $1",
      [v3Id],
    );
    expect(abandonedSteps).toEqual([]);

    // The pure never-published lineage has nothing to promote: still one row, disabled.
    const neverPublishedRows = await database.query<{ version: number; enabled: boolean }>(
      "SELECT version, enabled FROM routine_definition WHERE lineage_id = $1",
      [neverPublishedLineageId],
    );
    expect(neverPublishedRows).toEqual([expect.objectContaining({ version: 1, enabled: false })]);

    // Re-running 183 is a no-op: the promoted lineage's canonical row is now published, so it no
    // longer matches the promotion query's WHERE clause.
    await expect(applyTestMigration(database, migration183)).resolves.not.toThrow();
    const strandedRowsAfterRerun = await database.query<{ version: number }>(
      "SELECT version FROM routine_definition WHERE lineage_id = $1 ORDER BY version",
      [strandedLineageId],
    );
    expect(strandedRowsAfterRerun.map((row) => row.version)).toEqual([1, 2, 3, 4]);
  });
});
