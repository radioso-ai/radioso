import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { EvalRepository } from "../../src/modules/eval/services/evalRepository.js";
import type {
  AssertionVerdict,
  EvalAssertion,
  EvalRunObservedOutput,
  EvalRunOverrides,
  EvalRunResolvedConfig,
} from "../../src/modules/eval/domain/types.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of the EvalRepository. The eval service unit
// tests use in-memory fakes of EvalRepositoryPort, so this is the only coverage
// that exercises the actual SQL (now Kysely). Behaviour here — JSONB round-trips,
// ordering, status/last-run resets — is the spec the Kysely migration preserves.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("EvalRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new EvalRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Eval Test Co", `eval-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Eval Workspace", `ev-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'dashboard')`,
      [conversationId, workspaceId],
    );
  });

  afterAll(async () => {
    // ON DELETE CASCADE/RESTRICT: delete runs, then cases, then snapshots, then account.
    await database.query(`DELETE FROM eval_runs WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM eval_cases WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM eval_snapshots WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const createSnapshot = () =>
    repository.createSnapshot({
      workspaceId,
      sourceConversationId: conversationId,
      sourceMessageId: null,
      fidelity: "full",
      messages: [
        { role: "user", content: "What is the refund policy?" },
        { role: "assistant", content: "Refunds within 7 days." },
      ] as never,
      originalInstructionBlock: "You are a helpful support agent.",
      originalModelId: "test-model",
      originalRetrievalSettings: null,
      originalRetrievalResult: [{ chunkId: "c1", documentId: "d1", title: "Policy", rank: 1 }] as never,
      originalAgent: { id: "agent-1", name: "Support" } as never,
      originalAgentConfig: { customInstruction: "Be concise." } as never,
      sourceAgentId: null,
      capturedBy: null,
    });

  it("round-trips a snapshot with its JSONB payloads and string instruction block", async () => {
    const snapshot = await createSnapshot();

    expect(snapshot.id).toMatch(/[0-9a-f-]{36}/);
    expect(snapshot.workspaceId).toBe(workspaceId);
    expect(snapshot.sourceConversationId).toBe(conversationId);
    expect(snapshot.fidelity).toBe("full");
    expect(snapshot.messages).toHaveLength(2);
    // The instruction block is stored as a JSONB string and read back as a JS string.
    expect(snapshot.originalInstructionBlock).toBe("You are a helpful support agent.");
    expect(snapshot.originalRetrievalResult).toEqual([
      { chunkId: "c1", documentId: "d1", title: "Policy", rank: 1 },
    ]);
    expect(snapshot.originalAgent).toEqual({ id: "agent-1", name: "Support" });
    expect(snapshot.originalAgentConfig).toEqual({ customInstruction: "Be concise." });
    expect(snapshot.capturedAt).toEqual(expect.any(String));

    const found = await repository.findSnapshot(workspaceId, snapshot.id);
    expect(found).toEqual(snapshot);

    expect(await repository.findSnapshot(workspaceId, randomUUID())).toBeNull();
    expect(await repository.findSnapshot(randomUUID(), snapshot.id)).toBeNull();
  });

  it("creates, finds, and lists cases ordered by updated_at desc", async () => {
    const snapshot = await createSnapshot();
    const assertions: EvalAssertion[] = [
      { type: "answer_contains", pattern: "refund", matchMode: "substring", caseSensitive: false },
    ];

    const first = await repository.createCase({ workspaceId, snapshotId: snapshot.id, name: "Case One", assertions });
    expect(first.status).toBe("pending");
    expect(first.assertions).toEqual(assertions);
    expect(first.lastRunId).toBeNull();

    const second = await repository.createCase({
      workspaceId,
      snapshotId: snapshot.id,
      name: "Case Two",
      assertions: [],
    });

    const found = await repository.findCase(workspaceId, first.id);
    expect(found).toEqual(first);

    const cases = await repository.listCases(workspaceId);
    const ids = cases.map((c) => c.id);
    // Most-recently-updated first: Case Two was created after Case One.
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });

  it("resets status and clears last_run_id when assertions are edited", async () => {
    const snapshot = await createSnapshot();
    const created = await repository.createCase({
      workspaceId,
      snapshotId: snapshot.id,
      name: "Editable",
      assertions: [],
    });

    const run = await repository.createRun({
      workspaceId,
      snapshotId: snapshot.id,
      caseId: created.id,
      mode: "retrieval_only",
      overrides: {} as EvalRunOverrides,
      resolvedConfig: {} as EvalRunResolvedConfig,
      observedOutput: { retrievedChunks: [] } as EvalRunObservedOutput,
      assertionVerdicts: [] as AssertionVerdict[],
      status: "pass",
      outcomeReason: null,
      completedAt: new Date(),
    });
    const linked = await repository.updateCaseLastRun(workspaceId, created.id, run.id, "passing");
    expect(linked).not.toBeNull();
    expect(linked!.status).toBe("passing");
    expect(linked!.lastRunId).toBe(run.id);

    const newAssertions: EvalAssertion[] = [
      { type: "retrieval_includes_document", documentId: "doc-9" },
    ];
    const edited = await repository.updateCaseAssertions(workspaceId, created.id, newAssertions);
    expect(edited.assertions).toEqual(newAssertions);
    expect(edited.status).toBe("pending");
    expect(edited.lastRunId).toBeNull();
  });

  it("records a detached run when the requested case was deleted before insert", async () => {
    const snapshot = await createSnapshot();
    const missingCaseId = randomUUID();

    const run = await repository.createRun({
      workspaceId,
      snapshotId: snapshot.id,
      caseId: missingCaseId,
      mode: "retrieval_only",
      overrides: {} as EvalRunOverrides,
      resolvedConfig: {} as EvalRunResolvedConfig,
      observedOutput: { retrievedChunks: [] } as EvalRunObservedOutput,
      assertionVerdicts: [] as AssertionVerdict[],
      status: "recorded",
      outcomeReason: null,
      completedAt: new Date(),
    });

    expect(run.caseId).toBeNull();
  });

  it("returns null when last-run linking loses a delete race", async () => {
    const snapshot = await createSnapshot();
    const created = await repository.createCase({
      workspaceId,
      snapshotId: snapshot.id,
      name: "Link race",
      assertions: [],
    });
    const run = await repository.createRun({
      workspaceId,
      snapshotId: snapshot.id,
      caseId: created.id,
      mode: "retrieval_only",
      overrides: {} as EvalRunOverrides,
      resolvedConfig: {} as EvalRunResolvedConfig,
      observedOutput: { retrievedChunks: [] } as EvalRunObservedOutput,
      assertionVerdicts: [] as AssertionVerdict[],
      status: "recorded",
      outcomeReason: null,
      completedAt: new Date(),
    });
    expect(await repository.deleteCase(workspaceId, created.id)).toBe(true);

    await expect(
      repository.updateCaseLastRun(workspaceId, created.id, run.id, "passing"),
    ).resolves.toBeNull();
  });

  it("updates the case name without touching assertions", async () => {
    const snapshot = await createSnapshot();
    const assertions: EvalAssertion[] = [
      { type: "answer_contains", pattern: "x", matchMode: "substring" },
    ];
    const created = await repository.createCase({
      workspaceId,
      snapshotId: snapshot.id,
      name: "Old Name",
      assertions,
    });

    const renamed = await repository.updateCaseName(workspaceId, created.id, "New Name");
    expect(renamed.name).toBe("New Name");
    expect(renamed.assertions).toEqual(assertions);
    expect(renamed.status).toBe(created.status);
  });

  it("deletes a workspace-scoped case and detaches its historical runs", async () => {
    const snapshot = await createSnapshot();
    const created = await repository.createCase({
      workspaceId,
      snapshotId: snapshot.id,
      name: "Delete Case",
      assertions: [],
    });
    const run = await repository.createRun({
      workspaceId,
      snapshotId: snapshot.id,
      caseId: created.id,
      mode: "retrieval_only",
      overrides: {} as EvalRunOverrides,
      resolvedConfig: {} as EvalRunResolvedConfig,
      observedOutput: { retrievedChunks: [] } as EvalRunObservedOutput,
      assertionVerdicts: [] as AssertionVerdict[],
      status: "recorded",
      outcomeReason: null,
      completedAt: new Date(),
    });

    expect(await repository.deleteCase(randomUUID(), created.id)).toBe(false);
    expect(await repository.findCase(workspaceId, created.id)).toEqual(created);

    expect(await repository.deleteCase(workspaceId, created.id)).toBe(true);
    expect(await repository.deleteCase(workspaceId, created.id)).toBe(false);
    expect(await repository.findCase(workspaceId, created.id)).toBeNull();

    const runRows = await database.query<{ case_id: string | null }>(
      `SELECT case_id FROM eval_runs WHERE id = $1`,
      [run.id],
    );
    expect(runRows[0]?.case_id).toBeNull();
  });

  it("creates runs and lists them for a case ordered by started_at desc", async () => {
    const snapshot = await createSnapshot();
    const created = await repository.createCase({
      workspaceId,
      snapshotId: snapshot.id,
      name: "Runs Case",
      assertions: [],
    });

    const verdicts: AssertionVerdict[] = [
      {
        assertion: { type: "answer_contains", pattern: "refund", matchMode: "substring" },
        status: "pass",
        reason: "matched",
      },
    ];
    const observed: EvalRunObservedOutput = {
      retrievedChunks: [{ chunkId: "c1", documentId: "d1", title: "Policy", rank: 1 }],
      answer: "Refunds within 7 days.",
    };

    const runA = await repository.createRun({
      workspaceId,
      snapshotId: snapshot.id,
      caseId: created.id,
      mode: "full_assistant",
      overrides: { assistantInstructionsOverride: { customInstruction: "Be terse." } } as EvalRunOverrides,
      resolvedConfig: { modelId: "test-model" } as EvalRunResolvedConfig,
      observedOutput: observed,
      assertionVerdicts: verdicts,
      status: "pass",
      outcomeReason: null,
      completedAt: new Date(),
    });
    expect(runA.observedOutput).toEqual(observed);
    expect(runA.assertionVerdicts).toEqual(verdicts);
    expect(runA.completedAt).toEqual(expect.any(String));

    // Pre-allocated id round-trips.
    const preAllocated = randomUUID();
    const runB = await repository.createRun({
      id: preAllocated,
      workspaceId,
      snapshotId: snapshot.id,
      caseId: created.id,
      mode: "retrieval_only",
      overrides: {} as EvalRunOverrides,
      resolvedConfig: {} as EvalRunResolvedConfig,
      observedOutput: { retrievedChunks: [] },
      assertionVerdicts: [],
      status: "recorded",
      outcomeReason: "manual",
      completedAt: new Date(),
    });
    expect(runB.id).toBe(preAllocated);

    const runs = await repository.listRunsForCase(workspaceId, created.id);
    expect(runs.map((r) => r.id)).toContain(runA.id);
    expect(runs.map((r) => r.id)).toContain(runB.id);
    // Newest started_at first.
    expect(runs[0]?.id).toBe(runB.id);
  });
});
