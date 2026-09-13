import { describe, expect, it, vi } from "vitest";

import { createRoutineCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/proposalAdapters.js";

const workspaceId = "workspace-1";
const agentId = "11111111-1111-4111-8111-111111111111";
const routineId = "22222222-2222-4222-8222-222222222222";
const routine = { id: routineId, agentId, lineageId: "lineage-1", version: 1, name: "Returns", enabled: true, activation: { triggerDescription: "Handle returns.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" as const }, steps: [{ stableStepId: "step_collect", kind: "chat", instruction: "Collect details.", toolRef: null, ordinal: 0, metadata: {} }], terminals: [{ stableStepId: "terminal_done", kind: "complete", instruction: "Done.", ordinal: 0 }], slots: [], transitions: [{ fromStep: "step_collect", toRef: "terminal_done", guardKind: "default", guardText: null, ordinal: 0 }], createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z") };
const payload = { kind: "structural" as const, draft: { name: routine.name, enabled: false, activation: routine.activation, steps: routine.steps, terminals: routine.terminals, slots: routine.slots, transitions: routine.transitions }, operations: [{ kind: "set_enabled", enabled: false }] };

describe("structural routine proposal adapter", () => {
  it("routes reviewed MCP create and delete through the atomic owner-and-receipt port", async () => {
    const createDraft = vi.fn();
    const deleteDraft = vi.fn();
    const validate = vi.fn(async () => ({ ok: true, diagnostics: [] }));
    const apply = vi.fn()
      .mockResolvedValueOnce({ appliedRef: { agentId, routineId: "created-routine" }, routine: { ...routine, id: "created-routine" } })
      .mockResolvedValueOnce({ appliedRef: { agentId, routineId } });
    const adapter = createRoutineCopilotProposalAdapter({
      agentService: { get: vi.fn(async () => ({ updatedAt: new Date() })) } as never,
      routineDraftAssistService: {} as never,
      routineDefinitionService: { get: vi.fn(async () => routine), createDraft, deleteDraft, findCreateConflict: vi.fn(async () => null), validate, completeExternalDraftMutation: vi.fn() } as never,
      routineMcpApply: { apply },
      scopedReferences: { assertNoScopedReferences: vi.fn() },
    });
    const context = { surface: "mcp" as const, proposalId: "proposal-1", executionInvocationId: "receipt-1", operatorUserId: "operator-1", applyClaimedAt: new Date("2026-09-02T00:00:00Z") };
    const draft = { name: "Created", enabled: true, activation: routine.activation, steps: routine.steps, terminals: routine.terminals, slots: [], transitions: routine.transitions };

    await expect(adapter.applyIfVersionMatches(workspaceId, { agentId, routineId: null }, { kind: "create", draft }, "open", context)).resolves.toMatchObject({ outcome: "applied", appliedRef: { routineId: "created-routine" } });
    await expect(adapter.applyIfVersionMatches(workspaceId, { agentId, routineId }, { kind: "delete" }, routine.updatedAt.toISOString(), context)).resolves.toMatchObject({ outcome: "applied", appliedRef: { routineId } });
    expect(apply).toHaveBeenNthCalledWith(1, expect.objectContaining({ operation: "create", draft, proposalId: "proposal-1", executionInvocationId: "receipt-1" }));
    expect(apply).toHaveBeenNthCalledWith(2, expect.objectContaining({ operation: "delete", routineId, expectedUpdatedAt: routine.updatedAt }));
    expect(createDraft).not.toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it("keeps a deleted reviewed operation readable as a moved version rather than throwing", async () => {
    const adapter = createRoutineCopilotProposalAdapter({
      agentService: { get: vi.fn() },
      routineDraftAssistService: {} as never,
      routineDefinitionService: { get: vi.fn(async () => { throw new Error("Routine definition not found"); }) } as never,
    });
    await expect(adapter.readVersionToken(workspaceId, { agentId, routineId }, { kind: "delete" })).resolves.toBe("deleted");
  });

  it("allows a reclaimed pending atomic create or delete to retry after a pre-commit crash", async () => {
    const adapter = createRoutineCopilotProposalAdapter({ agentService: {}, routineDraftAssistService: {}, routineDefinitionService: {} });
    const base = { workspaceId, targetRef: { agentId, routineId }, versionToken: routine.updatedAt.toISOString(), executionInvocationId: "receipt-1", previousAttemptStartedAt: new Date() };
    await expect(adapter.reconcileMcpInterruptedApply?.({ ...base, payload: { kind: "create", draft: { name: "Created" } } })).resolves.toEqual({ outcome: "not_applied" });
    await expect(adapter.reconcileMcpInterruptedApply?.({ ...base, payload: { kind: "delete" } })).resolves.toEqual({ outcome: "not_applied" });
  });

  it("revalidates references added after review before atomic delete or structural removal", async () => {
    const apply = vi.fn();
    const assertNoScopedReferences = vi.fn(async () => { throw new Error("A scoped directive still references removed routine step \"step_collect\"."); });
    const adapter = createRoutineCopilotProposalAdapter({
      agentService: { get: vi.fn() },
      routineDraftAssistService: {} as never,
      routineDefinitionService: { get: vi.fn(async () => routine), validate: vi.fn(async () => ({ ok: true, diagnostics: [] })) } as never,
      routineMcpApply: { apply }, scopedReferences: { assertNoScopedReferences },
    });
    const context = { surface: "mcp" as const, proposalId: "proposal-1", executionInvocationId: "receipt-1", operatorUserId: "operator-1", applyClaimedAt: new Date("2026-09-02T00:00:00Z") };
    await expect(adapter.applyIfVersionMatches(workspaceId, { agentId, routineId }, { kind: "delete" }, routine.updatedAt.toISOString(), context)).rejects.toThrow(/scoped directive/);
    await expect(adapter.applyIfVersionMatches(workspaceId, { agentId, routineId }, { ...payload, draft: { ...payload.draft, steps: [{ ...routine.steps[0], stableStepId: "step_replacement" }] } }, routine.updatedAt.toISOString(), context)).rejects.toThrow(/scoped directive/);
    expect(assertNoScopedReferences).toHaveBeenNthCalledWith(1, expect.objectContaining({ removedNodeIds: ["step_collect", "terminal_done"] }));
    expect(assertNoScopedReferences).toHaveBeenNthCalledWith(2, expect.objectContaining({ removedNodeIds: ["step_collect"] }));
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies the prepared authoring draft once through owner CAS and rejects a stale fence", async () => {
    const get = vi.fn(async () => routine);
    const updateDraft = vi.fn(async () => ({ routine: { ...routine, enabled: false } }));
    const adapter = createRoutineCopilotProposalAdapter({ agentService: { get: vi.fn() }, routineDraftAssistService: {} as never, routineDefinitionService: { get, updateDraft, createDraft: vi.fn(), findCreateConflict: vi.fn(), list: vi.fn(), validate: vi.fn() } as never });
    const applied = await adapter.applyIfVersionMatches(workspaceId, { agentId, routineId }, payload, routine.updatedAt.toISOString());
    expect(applied).toMatchObject({ outcome: "applied" });
    expect(updateDraft).toHaveBeenCalledWith(workspaceId, agentId, routineId, expect.objectContaining({ enabled: false }), { expectedUpdatedAt: routine.updatedAt });
    await expect(adapter.applyIfVersionMatches(workspaceId, { agentId, routineId }, payload, new Date(0).toISOString())).resolves.toEqual({ outcome: "stale" });
    expect(updateDraft).toHaveBeenCalledOnce();
  });
});
