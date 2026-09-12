import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { AgentRevisionRepository } from "../../src/db/repositories/agentRevisionRepository.js";
import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import type {
  RoutineDefinition,
  RoutineDefinitionDeleteDraftResult,
  RoutineDefinitionDraftInput,
} from "../../src/modules/routines/public.js";
import { Database } from "../../src/shared/infra/database.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of RoutineDefinitionRepository. A routine is one row that is
// created, edited in place, taken in and out of service with `enabled`, and deleted with its
// whole lineage. The rows a lineage branched into before that collapse are still readable, so
// this also pins what the canonical-row reads do with legacy multi-version data and what
// `findPinnedById` still resolves for a conversation mid-routine.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("RoutineDefinitionRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new RoutineDefinitionRepository(database.kysely);
  const revisions = new AgentRevisionRepository(database.kysely);
  const emptyDraftSnapshot = {
    customInstruction: null,
    directives: [],
    routines: [],
    contextVariableEnablements: [],
  };

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  // A fresh agent per test isolates the `(agent_id, name, version)` unique constraint:
  // the default draft name/version would otherwise collide across tests under one agent.
  let agentId: string;

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Routine Test Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Routine Workspace", `route-${workspaceId}`],
    );
  });

  beforeEach(async () => {
    agentId = randomUUID();
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, `Routine Agent ${agentId}`],
    );
  });

  afterAll(async () => {
    // ON DELETE CASCADE removes workspaces/agents/routine_definition + children.
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const baseDraft = (overrides: Partial<RoutineDefinitionDraftInput> = {}): RoutineDefinitionDraftInput => ({
    name: "Refund flow",
    enabled: true,
    activation: {
      triggerDescription: "User asks for a refund",
      gateRef: null,
      priority: 5,
      reentryMode: "once_per_conversation",
    },
    slots: [
      { stableSlotId: "slot_order", key: "order_id", type: "text", required: true, description: "Order id", ordinal: 0 },
      { stableSlotId: "slot_amount", key: "amount", type: "number", required: false, description: null, ordinal: 1, mutable: true },
    ],
    steps: [
      { stableStepId: "step_ask", kind: "chat", instruction: "Ask for the order id", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
      { stableStepId: "step_done", kind: "chat", instruction: "Confirm the refund", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
    ],
    transitions: [
      {
        fromStep: "step_ask",
        toRef: "step_done",
        guardKind: "default",
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        fieldRef: null,
        fieldOp: null,
        fieldValue: null,
        fieldValues: null,
        fieldUnit: null,
        ordinal: 0,
      },
    ],
    terminals: [
      { stableStepId: "term_complete", kind: "complete", instruction: "All done", ordinal: 0 },
    ],
    ...overrides,
  });

  // baseDraft's declared-but-unreferenced slots and unreachable terminal are fine for the plain
  // storage/retrieval tests in this file, but a candidate/publish flow runs full release
  // validation (`assertCandidateSnapshotIsRunnable`), which rejects both. The publish-dependent
  // tests below need a routine that is actually runnable, not just storable.
  const runnableDraft = (overrides: Partial<RoutineDefinitionDraftInput> = {}): RoutineDefinitionDraftInput => ({
    name: "Runnable flow",
    enabled: true,
    activation: { triggerDescription: "User needs this routine", gateRef: null, priority: 1, reentryMode: "once_per_conversation" },
    slots: [],
    steps: [{ stableStepId: "step_only", kind: "chat", instruction: "Say hello", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
    transitions: [
      { fromStep: "step_only", toRef: "term_complete", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 },
    ],
    terminals: [{ stableStepId: "term_complete", kind: "complete", instruction: "Done", ordinal: 0 }],
    ...overrides,
  });

  /**
   * Writes a multi-row lineage the way the retired publish/revise flow left one behind. Nothing
   * in the application can produce this shape any more, so raw SQL is the only way to keep the
   * canonical-row and pinned-resume reads honest about data that is still in production tables.
   */
  const seedLegacyLineage = async (input: {
    agentId: string;
    lineageId: string;
    name: string;
    versions: readonly { id: string; version: number; status: string; enabled?: boolean; instruction: string }[];
  }): Promise<void> => {
    for (const version of input.versions) {
      await database.query(
        `INSERT INTO routine_definition (
           id, agent_id, lineage_id, version, name, status, enabled, activation_trigger_description, activation_priority
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)`,
        [
          version.id,
          input.agentId,
          input.lineageId,
          version.version,
          input.name,
          version.status,
          version.enabled ?? true,
          `Legacy ${input.name} v${version.version}`,
        ],
      );
      await database.query(
        `INSERT INTO routine_step (definition_id, stable_step_id, kind, instruction, ordinal)
         VALUES ($1, 'step_legacy', 'chat', $2, 0)`,
        [version.id, version.instruction],
      );
      await database.query(
        `INSERT INTO routine_terminal (definition_id, stable_step_id, kind, instruction, ordinal)
         VALUES ($1, 'term_legacy', 'complete', 'Legacy done', 0)`,
        [version.id],
      );
    }
  };

  const storedRows = (routineAgentId: string) =>
    database.query<{ id: string; version: number; status: string; enabled: boolean; lineage_id: string }>(
      `SELECT id::text, version, status, enabled, lineage_id::text
       FROM routine_definition WHERE agent_id = $1 ORDER BY version ASC`,
      [routineAgentId],
    );

  /** Gives an agent the private draft row the *WithAgentDraft repository methods require. */
  const initAgentDraft = (draftAgentId: string) =>
    database.query(
      `INSERT INTO agent_drafts (agent_id, workspace_id, generation, snapshot) VALUES ($1, $2, 1, $3::jsonb)`,
      [draftAgentId, workspaceId, JSON.stringify(emptyDraftSnapshot)],
    );

  /** Actually publishes the agent's current draft, the real (and only) publication boundary. */
  const publishAgentRevision = async (publishAgentId: string): Promise<void> => {
    const draft = await revisions.readDraft(workspaceId, publishAgentId);
    if (!draft) {
      throw new Error("expected an agent draft to publish");
    }
    const candidate = await revisions.createCandidate(workspaceId, publishAgentId, {
      id: randomUUID(),
      expectedDraftGeneration: draft.generation,
    });
    if (candidate === "conflict") {
      throw new Error("expected createCandidate to succeed against the current draft generation");
    }
    const published = await revisions.publish({
      workspaceId,
      agentId: publishAgentId,
      actorAccountId: null,
      revisionId: candidate.id,
      expectedDraftGeneration: draft.generation,
      expectedPublishedRevisionId: draft.basePublishedRevisionId,
      idempotencyKey: randomUUID(),
    });
    if (published === "conflict" || published === "idempotency_mismatch") {
      throw new Error(`expected publish to succeed, got ${published}`);
    }
  };

  it("createDraft persists one live row and its children", async () => {
    const created = await repository.createDraft(agentId, baseDraft());

    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.agentId).toBe(agentId);
    expect(created.version).toBe(1);
    expect(created.lineageId).toBe(created.id);
    expect(created.enabled).toBe(true);
    expect(created.name).toBe("Refund flow");
    expect(created.activation.priority).toBe(5);
    expect(created.slots).toHaveLength(2);
    expect(created.slots[0].stableSlotId).toBe("slot_order");
    expect(created.slots[1]).toMatchObject({ stableSlotId: "slot_amount", mutable: true });
    expect(created.steps).toHaveLength(2);
    expect(created.transitions).toHaveLength(1);
    expect(created.terminals).toHaveLength(1);
    expect(created.completionExport?.enabled).toBe(false);

    // One row, at version 1, its own lineage. The retired status column still carries a CHECK
    // constraint and still gates the webhook-destination triggers, so it has to be 'published'.
    expect(await storedRows(agentId)).toEqual([
      { id: created.id, version: 1, status: "published", enabled: true, lineage_id: created.id },
    ]);
  });

  it("createDraft carries an authored enabled:false straight through to storage", async () => {
    const parked = await repository.createDraft(agentId, baseDraft({ enabled: false }));

    expect(parked.enabled).toBe(false);
    expect(await repository.listActiveByAgent(agentId)).toEqual([]);
    expect((await repository.listByAgent(agentId)).map((routine) => routine.id)).toEqual([parked.id]);
  });

  it("round-trips activation coverage criteria and clears it on update", async () => {
    const created = await repository.createDraft(agentId, baseDraft({
      activation: { triggerDescription: "Coverage gap", gateRef: null, priority: 5, reentryMode: "once_per_conversation", coverageCriteria: { coverage: ["unanswered"], reasons: ["insufficient_evidence"] } },
    }));
    expect(created.activation.coverageCriteria).toEqual({ coverage: ["unanswered"], reasons: ["insufficient_evidence"] });
    const cleared = await repository.updateDraft(agentId, created.id, baseDraft({ name: "Cleared coverage" }));
    expect(cleared.activation.coverageCriteria).toBeUndefined();
  });

  it("updateDraft replaces children in place without branching the lineage", async () => {
    const created = await repository.createDraft(agentId, baseDraft());

    const updated = await repository.updateDraft(agentId, created.id, baseDraft({
      name: "Renamed flow",
      steps: [{ stableStepId: "step_only", kind: "chat", instruction: "One step now", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
      transitions: [],
    }));

    expect(updated.id).toBe(created.id);
    expect(updated.version).toBe(1);
    expect(updated.name).toBe("Renamed flow");
    expect(updated.steps.map((step) => step.stableStepId)).toEqual(["step_only"]);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    // Editing never adds a version: a routine is the one row it was created as.
    expect(await storedRows(agentId)).toHaveLength(1);
  });

  it("edits a legacy lineage's canonical row in place whatever status that row still carries", async () => {
    // Rows authored before routines collapsed to one row still hold draft / published /
    // superseded. Every id in the lineage addresses the lineage, and the write lands on its
    // highest version — the status column no longer gates anything.
    for (const canonicalStatus of ["draft", "published", "superseded"] as const) {
      const legacyAgentId = randomUUID();
      await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`, [
        legacyAgentId,
        workspaceId,
        `Legacy Agent ${legacyAgentId}`,
      ]);
      const lineageId = randomUUID();
      const olderId = randomUUID();
      const canonicalId = randomUUID();
      await seedLegacyLineage({
        agentId: legacyAgentId,
        lineageId,
        name: `legacy-${canonicalStatus}`,
        versions: [
          { id: olderId, version: 1, status: "superseded", instruction: "v1 instruction" },
          { id: canonicalId, version: 2, status: canonicalStatus, instruction: "v2 instruction" },
        ],
      });

      // Addressed through the OLD id, which is what a stale authoring surface would hold.
      const saved = await repository.updateDraft(legacyAgentId, olderId, baseDraft({ name: `legacy-${canonicalStatus}` }));

      expect(saved.id).toBe(canonicalId);
      expect(saved.version).toBe(2);
      expect(saved.steps.map((step) => step.stableStepId)).toEqual(["step_ask", "step_done"]);
      // The historical row is untouched by an edit to the lineage's canonical row.
      expect((await repository.findPinnedById(legacyAgentId, olderId))?.steps[0].instruction).toBe("v1 instruction");
    }
  });

  it("collapses a legacy lineage to its highest version for authoring reads", async () => {
    const lineageId = randomUUID();
    const v1 = randomUUID();
    const v2 = randomUUID();
    const v3 = randomUUID();
    await seedLegacyLineage({
      agentId,
      lineageId,
      name: "legacy-lineage",
      versions: [
        { id: v1, version: 1, status: "superseded", instruction: "v1 instruction" },
        { id: v2, version: 2, status: "published", instruction: "v2 instruction" },
        { id: v3, version: 3, status: "draft", instruction: "v3 instruction" },
      ],
    });

    const listed = await repository.listByAgent(agentId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: v3, version: 3, lineageId });

    // Every id in the lineage resolves to the same canonical row.
    for (const id of [v1, v2, v3]) {
      expect((await repository.findById(agentId, id))?.id).toBe(v3);
    }
    // History is still on disk for a pinned resume.
    expect((await repository.listVersionsByAgent(agentId)).map((routine) => routine.id)).toEqual([v1, v2, v3]);
  });

  it("findPinnedById returns the exact historical row, canonical or not", async () => {
    const lineageId = randomUUID();
    const supersededId = randomUUID();
    const canonicalId = randomUUID();
    await seedLegacyLineage({
      agentId,
      lineageId,
      name: "pinned-lineage",
      versions: [
        { id: supersededId, version: 1, status: "superseded", instruction: "pinned v1 instruction" },
        { id: canonicalId, version: 2, status: "published", instruction: "current v2 instruction" },
      ],
    });

    const pinned = await repository.findPinnedById(agentId, supersededId);
    expect(pinned).toMatchObject({ id: supersededId, version: 1, lineageId });
    expect(pinned?.steps[0].instruction).toBe("pinned v1 instruction");
    // The canonical read for the same id resolves forward; only the pinned read stays put.
    expect((await repository.findById(agentId, supersededId))?.id).toBe(canonicalId);
  });

  it("keeps a disabled routine out of the activation list while leaving it authorable", async () => {
    const parked = await repository.createDraft(agentId, baseDraft({ name: "Parked flow" }));
    const live = await repository.createDraft(agentId, baseDraft({ name: "Live flow" }));

    const disabled = await repository.updateDraft(agentId, parked.id, baseDraft({ name: "Parked flow", enabled: false }));
    expect(disabled.enabled).toBe(false);

    expect((await repository.listActiveByAgent(agentId)).map((routine) => routine.id)).toEqual([live.id]);
    expect((await repository.listByAgent(agentId)).map((routine) => routine.id).sort()).toEqual([live.id, parked.id].sort());
    expect((await repository.findById(agentId, parked.id))?.enabled).toBe(false);

    // …and back into service through the same in-place write.
    const reenabled = await repository.updateDraft(agentId, parked.id, baseDraft({ name: "Parked flow", enabled: true }));
    expect(reenabled.enabled).toBe(true);
    expect((await repository.listActiveByAgent(agentId)).map((routine) => routine.id).sort()).toEqual([live.id, parked.id].sort());
  });

  it("orders the activation list by priority", async () => {
    const low = await repository.createDraft(agentId, baseDraft({
      name: "Low priority",
      activation: { triggerDescription: "low", gateRef: null, priority: 1, reentryMode: "once_per_conversation" },
    }));
    const high = await repository.createDraft(agentId, baseDraft({
      name: "High priority",
      activation: { triggerDescription: "high", gateRef: null, priority: 90, reentryMode: "once_per_conversation" },
    }));

    expect((await repository.listActiveByAgent(agentId)).map((routine) => routine.id)).toEqual([high.id, low.id]);
  });

  it("refuses a guarded write once the row moved past the version the caller decided against", async () => {
    // An external authoring surface reads a routine, decides an edit, and writes later. Checking
    // the version in application code leaves a window a concurrent save lands in, so the guard has
    // to travel into the statement.
    const created = await repository.createDraft(agentId, baseDraft());
    const concurrent = await repository.updateDraft(agentId, created.id, baseDraft({ name: "Someone else's edit" }));

    await expect(repository.updateDraft(agentId, created.id, baseDraft({ name: "Stale edit" }), { expectedUpdatedAt: created.updatedAt }))
      .rejects.toThrow(`routine_definition_update_conflict:${created.id}`);
    expect((await repository.findById(agentId, created.id))?.name).toBe("Someone else's edit");

    const guarded = await repository.updateDraft(agentId, created.id, baseDraft({ name: "Current edit" }), { expectedUpdatedAt: concurrent.updatedAt });
    expect(guarded.name).toBe("Current edit");
  });

  it("advances an authored write token even when the database clock is behind the stored value", async () => {
    // A JS Date cannot carry Postgres microseconds, so every authored write must advance by at
    // least one whole millisecond. Moving the stored value into the future makes the regression
    // deterministic: assigning plain now() would move the token backwards, while a monotonic
    // assignment preserves the stale-write invariant regardless of clock precision or skew.
    const created = await repository.createDraft(agentId, baseDraft());
    await database.query(
      `UPDATE routine_definition
       SET updated_at = date_trunc('milliseconds', now()) + interval '1 hour'
       WHERE id = $1`,
      [created.id],
    );
    const before = await repository.findById(agentId, created.id);

    const updated = await repository.updateDraft(
      agentId,
      created.id,
      baseDraft({ name: "Monotonic token" }),
      { expectedUpdatedAt: before!.updatedAt },
    );

    expect(updated.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it("searches persisted trigger embeddings and identifies candidates without a usable vector", async () => {
    const first = await repository.createDraft(agentId, baseDraft({ name: "Refund search one" }));
    const second = await repository.createDraft(agentId, baseDraft({ name: "Refund search two" }));
    const firstVector = new Array<number>(1536).fill(0);
    firstVector[0] = 1;
    await repository.saveTriggerEmbedding({
      agentId,
      routineId: first.id,
      embedding: firstVector,
      model: "text-embedding-3-small",
      hash: "first",
    });

    const result = await repository.searchActivationTriggerEmbeddings({
      candidateRoutineIds: [first.id, second.id],
      embeddingModel: "text-embedding-3-small",
      queryEmbedding: firstVector,
      topK: 8,
    });

    expect(result.matches).toEqual([{ routineId: first.id, distance: 0 }]);
    expect(result.noVectorRoutineIds).toEqual([second.id]);
  });

  it("stores and searches non-1536-dimension vectors; model mismatch counts as no vector", async () => {
    // The column is typeless (migration 128): text-embedding-3-large produces
    // native 3072-dim vectors, and the model-equality predicate guarantees the
    // <=> comparison only ever sees same-width vectors.
    const routine = await repository.createDraft(agentId, baseDraft({ name: "Wide vector flow" }));
    const authoredUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
    await database.query(
      `UPDATE routine_definition SET updated_at = $1 WHERE id = $2`,
      [authoredUpdatedAt, routine.id],
    );
    const wideVector = new Array<number>(3072).fill(0);
    wideVector[1] = 1;
    await repository.saveTriggerEmbedding({
      agentId,
      routineId: routine.id,
      embedding: wideVector,
      model: "text-embedding-3-large",
      hash: "wide",
    });
    expect((await repository.findById(agentId, routine.id))?.updatedAt.toISOString()).toBe(
      authoredUpdatedAt.toISOString(),
    );

    const metadata = await repository.getTriggerEmbeddingMetadata(agentId, routine.id);
    expect(metadata).toEqual({ hash: "wide", model: "text-embedding-3-large" });

    const sameModel = await repository.searchActivationTriggerEmbeddings({
      candidateRoutineIds: [routine.id],
      embeddingModel: "text-embedding-3-large",
      queryEmbedding: wideVector,
      topK: 8,
    });
    expect(sameModel.matches).toEqual([{ routineId: routine.id, distance: 0 }]);
    expect(sameModel.noVectorRoutineIds).toEqual([]);

    const otherModel = await repository.searchActivationTriggerEmbeddings({
      candidateRoutineIds: [routine.id],
      embeddingModel: "text-embedding-3-small",
      queryEmbedding: new Array<number>(1536).fill(0.1),
      topK: 8,
    });
    expect(otherModel.matches).toEqual([]);
    expect(otherModel.noVectorRoutineIds).toEqual([routine.id]);

    await repository.clearTriggerEmbedding({ agentId, routineId: routine.id });
    expect(await repository.getTriggerEmbeddingMetadata(agentId, routine.id)).toEqual({ hash: null, model: null });
    expect((await repository.findById(agentId, routine.id))?.updatedAt.toISOString()).toBe(
      authoredUpdatedAt.toISOString(),
    );
  });

  it("keeps a routine that moved on from the version an undo stated", async () => {
    const created = await repository.createDraft(agentId, baseDraft());
    const moved = await repository.updateDraft(agentId, created.id, baseDraft({ name: "Saved by someone else" }));

    expect(await repository.deleteDraft(agentId, created.id, { expectedUpdatedAt: created.updatedAt })).toEqual({ outcome: "conflict" });
    expect(await repository.findById(agentId, created.id)).not.toBeNull();
    expect(await repository.deleteDraft(agentId, created.id, { expectedUpdatedAt: moved.updatedAt })).toEqual({ outcome: "deleted" });
  });

  it("deleting a lineage that has ever served disables it instead of removing its history", async () => {
    // A branched (pre-collapse) lineage can only exist because its earlier version was
    // published, so it may still back an in-flight conversation's routine_states pin. Hard
    // deletion would take that pin's `findPinnedById` lookup from "resume the version you
    // started" to "conversation broken" — deleting from the dashboard must disable instead.
    const lineageId = randomUUID();
    const supersededId = randomUUID();
    const canonicalId = randomUUID();
    await seedLegacyLineage({
      agentId,
      lineageId,
      name: "deletable-lineage",
      versions: [
        { id: supersededId, version: 1, status: "superseded", instruction: "v1 instruction" },
        { id: canonicalId, version: 2, status: "published", instruction: "v2 instruction" },
      ],
    });

    expect(await repository.deleteDraft(agentId, canonicalId)).toEqual({ outcome: "deleted" });

    expect(await repository.findPinnedById(agentId, supersededId)).not.toBeNull();
    const remainingCanonical = await repository.findById(agentId, canonicalId);
    expect(remainingCanonical?.enabled).toBe(false);
    expect((await repository.listActiveByAgent(agentId)).map((routine) => routine.id)).not.toContain(canonicalId);
  });

  it("deleting a single-row routine that was created disabled and never touched removes it outright", async () => {
    // The one shape that could never have activated: created out of service and deleted before
    // any other write landed on it. Nothing could ever have pinned it, so there is no history
    // to protect.
    const created = await repository.createDraft(agentId, baseDraft({ name: "never-served", enabled: false }));

    expect(await repository.deleteDraft(agentId, created.id)).toEqual({ outcome: "deleted" });

    expect(await repository.findById(agentId, created.id)).toBeNull();
    expect(await repository.findPinnedById(agentId, created.id)).toBeNull();
    expect(await storedRows(agentId)).toEqual([]);
  });

  it("deleting a routine right after creating it removes it outright, even though it defaults to enabled", async () => {
    // Regression guard: `enabled` defaults to true the instant a routine is created — long before
    // any operator gets a chance to touch it — so "currently enabled" is not a valid proxy for
    // "may have served". The real signal is whether the containing agent's draft was ever
    // released while this row existed; it never was here. Exercised through the *WithAgentDraft
    // methods — the real path an authoring-mistake-and-undo takes through the HTTP routes and
    // RoutineDefinitionService — not the bare methods, so this proves the production path.
    await initAgentDraft(agentId);
    const created = await repository.createDraftWithAgentDraft(workspaceId, agentId, baseDraft({ name: "immediate-undo" }));
    expect(created.enabled).toBe(true);

    expect(await repository.deleteDraftWithAgentDraft(workspaceId, agentId, created.id)).toEqual({ outcome: "deleted" });

    expect(await repository.findById(agentId, created.id)).toBeNull();
    expect(await repository.findPinnedById(agentId, created.id)).toBeNull();

    // The name is immediately reusable — nothing was left behind to collide with.
    const recreated = await repository.createDraftWithAgentDraft(workspaceId, agentId, baseDraft({ name: "immediate-undo" }));
    expect(recreated.id).not.toBe(created.id);
  });

  it("deleting a routine created after the agent's last publish removes it outright, even though the agent has published before", async () => {
    // Precision guard on the "could have served" signal: it is not "has this agent EVER
    // published anything", it is "has the agent published a revision created at or after THIS
    // row's own creation" — a revision minted before the row existed cannot possibly have
    // captured it in its snapshot. An agent with old publish history must not make every later
    // routine permanently unhard-deletable regardless of whether it was ever actually released.
    await initAgentDraft(agentId);
    await publishAgentRevision(agentId);

    const created = await repository.createDraftWithAgentDraft(workspaceId, agentId, baseDraft({ name: "created-after-last-publish" }));
    expect(await repository.deleteDraftWithAgentDraft(workspaceId, agentId, created.id)).toEqual({ outcome: "deleted" });

    expect(await repository.findById(agentId, created.id)).toBeNull();
    expect(await repository.findPinnedById(agentId, created.id)).toBeNull();
  });

  it("deleting a routine that was actually included in a published agent revision disables rather than removes it", async () => {
    // The agent revision system is the only publication boundary in the collapsed model, so
    // "may have served" must be judged against it, not against the routine's own enabled column.
    await initAgentDraft(agentId);
    const created = await repository.createDraftWithAgentDraft(workspaceId, agentId, runnableDraft({ name: "was-live" }));
    await publishAgentRevision(agentId);

    expect(await repository.deleteDraftWithAgentDraft(workspaceId, agentId, created.id)).toEqual({ outcome: "deleted" });

    expect(await repository.findPinnedById(agentId, created.id)).not.toBeNull();
    expect((await repository.findById(agentId, created.id))?.enabled).toBe(false);
  });

  it("a routine soft-disabled in lieu of deletion stays listed and blocks reusing its name", async () => {
    // A lineage that has ever served can't be hard-deleted (findPinnedById must keep resolving
    // it for a conversation that pinned it), so "delete" disables it instead. Nothing in the
    // schema distinguishes that from an operator's own enabled-toggle, so it surfaces
    // identically: listed, authorable, and still holding its (agent_id, name, version) slot —
    // the same contract an operator-disabled routine already has (see the test above).
    await initAgentDraft(agentId);
    const created = await repository.createDraftWithAgentDraft(workspaceId, agentId, runnableDraft({ name: "Reused name" }));
    await publishAgentRevision(agentId);

    expect(await repository.deleteDraftWithAgentDraft(workspaceId, agentId, created.id)).toEqual({ outcome: "deleted" });

    const listed = await repository.listByAgent(agentId);
    expect(listed.map((routine) => routine.id)).toContain(created.id);
    expect(listed.find((routine) => routine.id === created.id)?.enabled).toBe(false);

    // Reusing the name collides on (agent_id, name, version=1), exactly as it would for an
    // operator-disabled routine of the same name — not a new gap this round introduces.
    await expect(repository.createDraftWithAgentDraft(workspaceId, agentId, runnableDraft({ name: "Reused name" })))
      .rejects.toThrow(/routine_definition_agent_id_name_version_key/);
  });

  it("guards the disable-in-place write against a concurrent edit its caller's read predates", async () => {
    // deleteDraft's own precheck compares the row it just read against the caller's stated
    // expectation, so driving it end-to-end can only ever exercise that early check: nothing
    // changes the row between deleteDraft's own read and its own write within a single call.
    // Calling the private disable-in-place write directly, against a canonical snapshot the
    // database has since moved past, reproduces the window a genuinely concurrent request lands
    // in — the gap `expectedUpdatedAt` on every other mutator in this file exists to close.
    const created = await repository.createDraft(agentId, baseDraft({ name: "Guarded flow" }));
    const concurrent = await repository.updateDraft(agentId, created.id, baseDraft({ name: "Someone else's edit" }));

    const deleteLineageOn = (repository as unknown as {
      deleteLineageOn(
        db: Db,
        agentId: string,
        canonical: RoutineDefinition,
        options?: { expectedUpdatedAt?: Date },
      ): Promise<RoutineDefinitionDeleteDraftResult>;
    }).deleteLineageOn.bind(repository);

    const result = await deleteLineageOn(database.kysely, agentId, created, { expectedUpdatedAt: created.updatedAt });

    expect(result).toEqual({ outcome: "conflict" });
    const stillCurrent = await repository.findById(agentId, created.id);
    expect(stillCurrent?.name).toBe("Someone else's edit");
    expect(stillCurrent?.enabled).toBe(true);
    expect(stillCurrent?.updatedAt.getTime()).toBe(concurrent.updatedAt.getTime());
  });

  it("scopes list and find methods by agent", async () => {
    const localAgent = randomUUID();
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`, [
      localAgent,
      workspaceId,
      "List Agent",
    ]);

    const mine = await repository.createDraft(localAgent, baseDraft({ name: "List flow" }));
    const theirs = await repository.createDraft(agentId, baseDraft({ name: "Other agent flow" }));

    expect((await repository.listByAgent(localAgent)).map((routine) => routine.id)).toEqual([mine.id]);
    expect((await repository.listActiveByAgent(localAgent)).map((routine) => routine.id)).toEqual([mine.id]);
    expect(await repository.findById(localAgent, theirs.id)).toBeNull();
    expect(await repository.findPinnedById(localAgent, theirs.id)).toBeNull();

    await database.query(`DELETE FROM routine_definition WHERE agent_id = $1`, [localAgent]).catch(() => undefined);
    await database.query(`DELETE FROM agents WHERE id = $1`, [localAgent]).catch(() => undefined);
  });

  it("listRoutineNamesReferencingDestination matches enabled exports case-insensitively", async () => {
    // The completion export's destination_ref must reference a real workspace webhook
    // destination (a database trigger validates it), so seed one and key off its id.
    const destinationId = randomUUID();
    await database.query(
      `INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext, encryption_key_id)
       VALUES ($1, $2, $3, 'https://example.test/webhook', 'ciphertext', 'test-key')`,
      [destinationId, workspaceId, `Export dest ${destinationId}`],
    );
    await repository.createDraft(
      agentId,
      baseDraft({
        name: "Export flow",
        completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: destinationId },
      }),
    );

    const names = await repository.listRoutineNamesReferencingDestination(
      workspaceId,
      destinationId.toUpperCase(),
    );
    expect(names).toContain("Export flow");
  });

  it("listRoutineNamesReferencingDestination excludes a disabled routine's reference", async () => {
    // The friendly pre-check in WebhookDestinationService.delete calls this before ever
    // attempting the delete; it must agree with the DB trigger (migration 182) on which
    // routines actually hold a destination in service, or it would report a block the trigger
    // itself no longer enforces.
    const destinationId = randomUUID();
    await database.query(
      `INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext, encryption_key_id)
       VALUES ($1, $2, $3, 'https://example.test/webhook', 'ciphertext', 'test-key')`,
      [destinationId, workspaceId, `Excluded dest ${destinationId}`],
    );
    const created = await repository.createDraft(
      agentId,
      baseDraft({
        name: "Excluded flow",
        completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: destinationId },
      }),
    );
    expect(await repository.listRoutineNamesReferencingDestination(workspaceId, destinationId))
      .toContain("Excluded flow");

    await repository.updateDraft(agentId, created.id, baseDraft({
      name: "Excluded flow",
      enabled: false,
      completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: destinationId },
    }));

    expect(await repository.listRoutineNamesReferencingDestination(workspaceId, destinationId))
      .not.toContain("Excluded flow");
  });

  it("releases the webhook destination delete-block once the sole referencing routine is disabled", async () => {
    // Migration 089's delete-block trigger gated on `status = 'published'`. The application
    // stopped writing status transitions once the lifecycle collapse (migration 181) landed —
    // every row is inserted 'published' and stays there — so that condition became permanently
    // true and disabling a routine could never again release a destination it once referenced.
    // This is DB-trigger behavior a fake repository cannot exercise; it needs real Postgres.
    const destinationId = randomUUID();
    await database.query(
      `INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext, encryption_key_id)
       VALUES ($1, $2, $3, 'https://example.test/webhook', 'ciphertext', 'test-key')`,
      [destinationId, workspaceId, `Release dest ${destinationId}`],
    );
    const created = await repository.createDraft(
      agentId,
      baseDraft({
        name: "Release flow",
        completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: destinationId },
      }),
    );

    await expect(database.query(`DELETE FROM workspace_webhook_destinations WHERE id = $1`, [destinationId]))
      .rejects.toThrow(/referenced by/i);

    await repository.updateDraft(agentId, created.id, baseDraft({
      name: "Release flow",
      enabled: false,
      completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: destinationId },
    }));

    await database.query(`DELETE FROM workspace_webhook_destinations WHERE id = $1`, [destinationId]);
    expect(await database.query(`SELECT 1 FROM workspace_webhook_destinations WHERE id = $1`, [destinationId]))
      .toEqual([]);
  });

  it("keeps blocking the webhook destination delete while a referencing routine stays enabled", async () => {
    const destinationId = randomUUID();
    await database.query(
      `INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext, encryption_key_id)
       VALUES ($1, $2, $3, 'https://example.test/webhook', 'ciphertext', 'test-key')`,
      [destinationId, workspaceId, `Blocked dest ${destinationId}`],
    );
    await repository.createDraft(
      agentId,
      baseDraft({
        name: "Blocked flow",
        completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: destinationId },
      }),
    );

    await expect(database.query(`DELETE FROM workspace_webhook_destinations WHERE id = $1`, [destinationId]))
      .rejects.toThrow(/referenced by/i);
  });

  it("preserves a field guard value of 0 and false through jsonb serialization", async () => {
    const draftWithZero = baseDraft({
      name: "Field guard flow",
      transitions: [
        {
          fromStep: "step_ask",
          toRef: "step_done",
          guardKind: "field",
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          fieldRef: "amount",
          fieldOp: "equals",
          fieldValue: 0,
          fieldValues: null,
          fieldUnit: null,
          ordinal: 0,
        },
        {
          fromStep: "step_ask",
          toRef: "step_done",
          guardKind: "field",
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          fieldRef: "flag",
          fieldOp: "equals",
          fieldValue: false,
          fieldValues: null,
          fieldUnit: null,
          ordinal: 1,
        },
      ],
    });

    const created = await repository.createDraft(agentId, draftWithZero);
    const zero = created.transitions.find((t) => t.fieldRef === "amount");
    const falsey = created.transitions.find((t) => t.fieldRef === "flag");

    // The explicit null/undefined guard (not a truthy check) must let 0 and false survive,
    // not collapse them to NULL.
    expect(zero?.fieldValue).toBe(0);
    expect(falsey?.fieldValue).toBe(false);
  });
});
