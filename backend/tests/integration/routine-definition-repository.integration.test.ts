import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of RoutineDefinitionRepository. This is the spec the
// Kysely migration must preserve: the draft/publish lifecycle, the supersede + onPublished
// transaction hand-off, the unique-version revision draft, the restore NOT EXISTS guard,
// and the jsonb field-guard `0`/`false` serialization edge.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("RoutineDefinitionRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new RoutineDefinitionRepository(database.kysely);

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

  it("createDraft persists the definition and its children", async () => {
    const created = await repository.createDraft(agentId, baseDraft());

    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.agentId).toBe(agentId);
    expect(created.status).toBe("draft");
    expect(created.version).toBe(1);
    expect(created.name).toBe("Refund flow");
    expect(created.activation.priority).toBe(5);
    expect(created.slots).toHaveLength(2);
    expect(created.slots[0].stableSlotId).toBe("slot_order");
    expect(created.slots[1]).toMatchObject({ stableSlotId: "slot_amount", mutable: true });
    expect(created.steps).toHaveLength(2);
    expect(created.transitions).toHaveLength(1);
    expect(created.terminals).toHaveLength(1);
    expect(created.completionExport?.enabled).toBe(false);
  });

  it("updateDraft replaces children and bumps updated_at; conflict when not a draft", async () => {
    const created = await repository.createDraft(agentId, baseDraft());

    const updated = await repository.updateDraft(agentId, created.id, baseDraft({ name: "Renamed flow" }));
    expect(updated.name).toBe("Renamed flow");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    // Publishing flips the row out of `draft`; a subsequent updateDraft must conflict.
    await repository.publish(agentId, created.id);
    await expect(repository.updateDraft(agentId, created.id, baseDraft())).rejects.toThrow(
      `routine_definition_update_conflict:${created.id}`,
    );
  });

  it("searches persisted trigger embeddings and identifies candidates without a usable vector", async () => {
    const first = await repository.createDraft(agentId, baseDraft({ name: "Refund search one" }));
    const second = await repository.createDraft(agentId, baseDraft({ name: "Refund search two" }));
    await repository.publish(agentId, first.id);
    await repository.publish(agentId, second.id);
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
    await repository.publish(agentId, routine.id);
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

  it("publish supersedes the prior published row, hands a working transaction to onPublished, and conflicts when re-published", async () => {
    const first = await repository.createDraft(agentId, baseDraft());
    await repository.publish(agentId, first.id);

    // Revision draft off the published row, then publish it: the first should be superseded.
    const revision = await repository.createRevisionDraft(agentId, first.id);
    expect(revision).not.toBeNull();

    let received: { previousPublishedId: string | null; newDefinitionId: string } | null = null;
    const published = await repository.publish(agentId, revision!.id, {
      onPublished: async ({ previousPublishedId, newDefinitionId, transaction }) => {
        received = { previousPublishedId, newDefinitionId };
        // The transaction must be a usable Kysely executor still inside the publish tx:
        // the just-published row is visible to it but not yet committed.
        const trx = transaction as Db;
        const row = await trx
          .selectFrom("routine_definition")
          .select("status")
          .where("id", "=", newDefinitionId)
          .executeTakeFirst();
        expect(row?.status).toBe("published");
      },
    });

    expect(published.status).toBe("published");
    expect(received).not.toBeNull();
    expect(received!.previousPublishedId).toBe(first.id);
    expect(received!.newDefinitionId).toBe(revision!.id);

    const supersededReload = await repository.findById(agentId, first.id);
    expect(supersededReload?.status).toBe("superseded");

    // Re-publishing an already-published (non-draft) id conflicts.
    await expect(repository.publish(agentId, published.id)).rejects.toThrow(
      `routine_definition_publish_conflict:${published.id}`,
    );
  });

  it("createRevisionDraft increments the version and is idempotent per lineage", async () => {
    const first = await repository.createDraft(agentId, baseDraft());
    await repository.publish(agentId, first.id);

    const revision = await repository.createRevisionDraft(agentId, first.id);
    expect(revision).not.toBeNull();
    expect(revision!.version).toBe(2);
    expect(revision!.lineageId).toBe(first.lineageId);
    expect(revision!.status).toBe("draft");

    // Second call returns the existing draft, not a third version.
    const again = await repository.createRevisionDraft(agentId, first.id);
    expect(again!.id).toBe(revision!.id);
    expect(again!.version).toBe(2);
  });

  it("archive then restore round-trips; restore is guarded against a second published row", async () => {
    const first = await repository.createDraft(agentId, baseDraft());
    await repository.publish(agentId, first.id);

    expect(await repository.archive(agentId, first.id)).toBe(true);
    expect((await repository.findById(agentId, first.id))?.status).toBe("archived");

    expect(await repository.restore(agentId, first.id)).toBe(true);
    expect((await repository.findById(agentId, first.id))?.status).toBe("published");

    // Archiving retires the routine and discards any pending revision draft.
    const revision = await repository.createRevisionDraft(agentId, first.id);
    expect(await repository.archive(agentId, first.id)).toBe(true);
    expect(await repository.findById(agentId, revision!.id)).toBeNull();
    expect(await repository.restore(agentId, first.id)).toBe(true);

    // Force an archived older row beside a live published row to exercise the restore
    // NOT EXISTS guard directly without depending on a draft surviving archive.
    const nextRevision = await repository.createRevisionDraft(agentId, first.id);
    expect(nextRevision).not.toBeNull();
    await repository.publish(agentId, nextRevision!.id);
    await database.query(`UPDATE routine_definition SET status = 'archived' WHERE id = $1`, [first.id]);

    expect(await repository.restore(agentId, first.id)).toBe(false);
    expect((await repository.findById(agentId, first.id))?.status).toBe("archived");
  });

  it("deleteDraft removes only drafts", async () => {
    const draft = await repository.createDraft(agentId, baseDraft());
    expect(await repository.deleteDraft(agentId, draft.id)).toBe(true);
    expect(await repository.findById(agentId, draft.id)).toBeNull();

    const published = await repository.createDraft(agentId, baseDraft());
    await repository.publish(agentId, published.id);
    expect(await repository.deleteDraft(agentId, published.id)).toBe(false);
  });

  it("list/find methods scope by agent and status", async () => {
    const localAgent = randomUUID();
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`, [
      localAgent,
      workspaceId,
      "List Agent",
    ]);

    const draft = await repository.createDraft(localAgent, baseDraft({ name: "List flow" }));
    const publishedDraft = await repository.createDraft(localAgent, baseDraft({ name: "Published flow" }));
    const published = await repository.publish(localAgent, publishedDraft.id);

    const all = await repository.listByAgent(localAgent);
    expect(all.map((d) => d.id).sort()).toEqual([draft.id, published.id].sort());

    const publishedOnly = await repository.listPublishedByAgent(localAgent);
    expect(publishedOnly.map((d) => d.id)).toEqual([published.id]);

    // findPinnedById excludes drafts.
    expect(await repository.findPinnedById(localAgent, draft.id)).toBeNull();
    expect((await repository.findPinnedById(localAgent, published.id))?.id).toBe(published.id);

    await database.query(`DELETE FROM routine_definition WHERE agent_id = $1`, [localAgent]).catch(() => undefined);
    await database.query(`DELETE FROM agents WHERE id = $1`, [localAgent]).catch(() => undefined);
  });

  it("listPublishedRoutineNamesReferencingDestination matches enabled exports case-insensitively", async () => {
    // The completion export's destination_ref must reference a real workspace webhook
    // destination (a publish-time trigger validates it), so seed one and key off its id.
    const destinationId = randomUUID();
    await database.query(
      `INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext, encryption_key_id)
       VALUES ($1, $2, $3, 'https://example.test/webhook', 'ciphertext', 'test-key')`,
      [destinationId, workspaceId, `Export dest ${destinationId}`],
    );
    const draft = await repository.createDraft(
      agentId,
      baseDraft({
        name: "Export flow",
        completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: destinationId },
      }),
    );
    await repository.publish(agentId, draft.id);

    const names = await repository.listPublishedRoutineNamesReferencingDestination(
      workspaceId,
      destinationId.toUpperCase(),
    );
    expect(names).toContain("Export flow");
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
