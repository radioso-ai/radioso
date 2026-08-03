import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { EvalRepository } from "../../src/modules/eval/services/evalRepository.js";
import { EvalMessageCaseRepository } from "../../src/modules/eval/services/evalMessageCaseRepository.js";
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
  const messageCaseRepository = new EvalMessageCaseRepository(database.kysely);

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
    await database.query(`UPDATE workspaces SET default_agent_id = NULL WHERE id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM agents WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const createSnapshot = () =>
    repository.createSnapshot({
      workspaceId,
      sourceConversationId: conversationId,
      sourceMessageId: null,
      replayTarget: { userMessageId: "message-user-1", assistantMessageId: null },
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
      originalRoutineState: null,
      capturedBy: null,
    });

  it("round-trips a snapshot with its JSONB payloads and string instruction block", async () => {
    const snapshot = await createSnapshot();

    expect(snapshot.id).toMatch(/[0-9a-f-]{36}/);
    expect(snapshot.workspaceId).toBe(workspaceId);
    expect(snapshot.sourceConversationId).toBe(conversationId);
    expect(snapshot.replayTarget).toEqual({ userMessageId: "message-user-1", assistantMessageId: null });
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

  it("lists cases with the most recent run per case", async () => {
    const snapshot = await createSnapshot();
    const assertions: EvalAssertion[] = [
      { type: "answer_contains", pattern: "refund", matchMode: "substring" },
    ];
    const scored = await repository.createCase({
      workspaceId,
      snapshotId: snapshot.id,
      name: "Scored with runs",
      assertions,
    });
    const neverRun = await repository.createCase({
      workspaceId,
      snapshotId: snapshot.id,
      name: "Never run",
      assertions,
    });

    const makeRun = (status: "pass" | "fail", resolvedConfig: EvalRunResolvedConfig, completedAt: Date) =>
      repository.createRun({
        workspaceId,
        snapshotId: snapshot.id,
        caseId: scored.id,
        mode: "full_assistant",
        overrides: {} as EvalRunOverrides,
        resolvedConfig,
        observedOutput: { retrievedChunks: [] } as EvalRunObservedOutput,
        assertionVerdicts: [] as AssertionVerdict[],
        status,
        outcomeReason: status === "fail" ? "Did not match" : null,
        completedAt,
      });

    await makeRun("fail", {} as EvalRunResolvedConfig, new Date(Date.now() - 60_000));
    const latest = await makeRun("pass", { modelId: "gpt-5-mini" } as EvalRunResolvedConfig, new Date());

    const items = await repository.listCasesWithLatestRun(workspaceId);
    const byId = new Map(items.map((item) => [item.id, item]));

    // The latest run wins, carrying its status and resolved model.
    expect(byId.get(scored.id)?.latestRun).toMatchObject({
      id: latest.id,
      status: "pass",
      mode: "full_assistant",
      modelId: "gpt-5-mini",
    });
    // A case that has never run reports no latest run.
    expect(byId.get(neverRun.id)?.latestRun).toBeNull();

    // The snapshot here has no source_agent_id and a config without a name, so
    // the agent ref falls back to the legacy thin original_agent name.
    expect(byId.get(scored.id)?.agent).toEqual({
      agentId: null,
      name: "Support",
      internalName: null,
      deleted: false,
    });
  });

  it("attributes cases to the live agent, and marks a removed agent's frozen name", async () => {
    const agentId = randomUUID();
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, "Concierge"],
    );

    const snapshot = await repository.createSnapshot({
      workspaceId,
      sourceConversationId: conversationId,
      sourceMessageId: null,
      replayTarget: null,
      fidelity: "full",
      messages: [{ role: "user", content: "hi" }] as never,
      originalInstructionBlock: null,
      originalModelId: null,
      originalRetrievalSettings: null,
      originalRetrievalResult: null,
      // Capture-time name differs from the live row so we can tell which one wins.
      originalAgent: { id: agentId, name: "Concierge (old)" } as never,
      originalAgentConfig: { name: "Concierge (frozen)" } as never,
      sourceAgentId: agentId,
      originalRoutineState: null,
      capturedBy: null,
    });
    const evalCase = await repository.createCase({
      workspaceId,
      snapshotId: snapshot.id,
      name: "Attributed",
      assertions: [],
    });

    const findAgent = async () =>
      (await repository.listCasesWithLatestRun(workspaceId)).find((item) => item.id === evalCase.id)
        ?.agent;

    // Live agent present: current name wins, not deleted.
    expect(await findAgent()).toEqual({
      agentId,
      name: "Concierge",
      internalName: null,
      deleted: false,
    });

    // Remove the agent row (source_agent_id has no FK, so it survives on the
    // snapshot): the ref keeps the id, falls back to the frozen name, marks removed.
    await database.query(`UPDATE workspaces SET default_agent_id = NULL WHERE id = $1`, [workspaceId]);
    await database.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    expect(await findAgent()).toEqual({
      agentId,
      name: "Concierge (frozen)",
      internalName: null,
      deleted: true,
    });
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

  it("atomically finds or creates one case association for an assistant message", async () => {
    const assistantMessageId = randomUUID();
    await database.query(
      `INSERT INTO messages
         (id, conversation_id, workspace_id, role, content, source)
       VALUES ($1, $2, $3, 'assistant', 'Refunds are available within seven days.', 'ai_agent')`,
      [assistantMessageId, conversationId, workspaceId],
    );

    await expect(
      messageCaseRepository.findSourceMessage(workspaceId, assistantMessageId),
    ).resolves.toMatchObject({
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      source: "ai_agent",
    });
    await expect(
      messageCaseRepository.findSourceMessage(randomUUID(), assistantMessageId),
    ).resolves.toBeNull();

    const snapshot = {
      workspaceId,
      sourceConversationId: conversationId,
      sourceMessageId: assistantMessageId,
      replayTarget: { userMessageId: randomUUID(), assistantMessageId },
      fidelity: "messages_only" as const,
      messages: [
        {
          id: assistantMessageId,
          role: "assistant" as const,
          content: "Refunds are available within seven days.",
          createdAt: new Date().toISOString(),
        },
      ],
      originalInstructionBlock: null,
      originalModelId: null,
      originalRetrievalSettings: null,
      originalRetrievalResult: null,
      originalAgent: null,
      originalAgentConfig: null,
      sourceAgentId: null,
      originalRoutineState: null,
      capturedBy: null,
    };

    const [first, second] = await Promise.all([
      messageCaseRepository.findOrCreateMessageCase({
        workspaceId,
        assistantMessageId,
        createdBy: null,
        snapshot,
        caseName: "Refund policy",
      }),
      messageCaseRepository.findOrCreateMessageCase({
        workspaceId,
        assistantMessageId,
        createdBy: null,
        snapshot,
        caseName: "Refund policy",
      }),
    ]);

    expect(first.case.id).toBe(second.case.id);
    expect(first.snapshot.id).toBe(second.snapshot.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    await expect(
      messageCaseRepository.findMessageCase(workspaceId, assistantMessageId),
    ).resolves.toEqual({
      assistantMessageId,
      case: first.case,
      snapshot: first.snapshot,
      createdBy: null,
      createdAt: expect.any(String),
    });

    const counts = await database.query<{ associations: string; cases: string; snapshots: string }>(
      `SELECT
         (SELECT count(*) FROM eval_message_case_associations
          WHERE workspace_id = $1 AND assistant_message_id = $2)::text AS associations,
         (SELECT count(*) FROM eval_cases
          WHERE workspace_id = $1 AND id = $3)::text AS cases,
         (SELECT count(*) FROM eval_snapshots
          WHERE workspace_id = $1 AND id = $4)::text AS snapshots`,
      [workspaceId, assistantMessageId, first.case.id, first.snapshot.id],
    );
    expect(counts[0]).toEqual({ associations: "1", cases: "1", snapshots: "1" });

    await repository.deleteCase(workspaceId, first.case.id);
    await expect(
      messageCaseRepository.findMessageCase(workspaceId, assistantMessageId),
    ).resolves.toBeNull();
  });

  it("looks up linked case verification state in one bounded projection", async () => {
    const assistantMessageId = randomUUID();
    const unlinkedMessageId = randomUUID();
    await database.query(
      `INSERT INTO messages
         (id, conversation_id, workspace_id, role, content, source)
       VALUES
         ($1, $3, $4, 'assistant', 'Linked answer', 'ai_agent'),
         ($2, $3, $4, 'assistant', 'Unlinked answer', 'ai_agent')`,
      [assistantMessageId, unlinkedMessageId, conversationId, workspaceId],
    );
    const snapshotInput = {
      workspaceId,
      sourceConversationId: conversationId,
      sourceMessageId: assistantMessageId,
      replayTarget: { userMessageId: randomUUID(), assistantMessageId },
      fidelity: "messages_only" as const,
      messages: [],
      originalInstructionBlock: null,
      originalModelId: null,
      originalRetrievalSettings: null,
      originalRetrievalResult: null,
      originalAgent: null,
      originalAgentConfig: null,
      sourceAgentId: null,
      originalRoutineState: null,
      capturedBy: null,
    };
    const linked = await messageCaseRepository.findOrCreateMessageCase({
      workspaceId,
      assistantMessageId,
      createdBy: null,
      snapshot: snapshotInput,
      caseName: "Linked case",
    });
    const completedAt = new Date();
    const run = await repository.createRun({
      workspaceId,
      snapshotId: linked.snapshot.id,
      caseId: linked.case.id,
      mode: "full_assistant",
      overrides: {},
      resolvedConfig: {},
      observedOutput: { retrievedChunks: [] },
      assertionVerdicts: [],
      status: "pass",
      outcomeReason: null,
      completedAt,
    });
    await repository.updateCaseLastRun(workspaceId, linked.case.id, run.id, "passing");

    const verifications = await messageCaseRepository.lookupMessageCaseVerifications(
      workspaceId,
      [assistantMessageId, unlinkedMessageId],
    );

    expect([...verifications.entries()]).toEqual([
      [assistantMessageId, {
        caseId: linked.case.id,
        caseStatus: "passing",
        latestRunStatus: "pass",
        latestRunAt: completedAt.toISOString(),
      }],
    ]);
  });
});
