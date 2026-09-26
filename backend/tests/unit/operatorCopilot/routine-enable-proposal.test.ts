import { describe, expect, it, vi } from "vitest";

import { createRoutineCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/proposalAdapters.js";

const workspaceId = "workspace-1";
const agentId = "11111111-1111-4111-8111-111111111111";
const routineId = "22222222-2222-4222-8222-222222222222";
const parkedRoutine = {
  id: routineId, agentId, lineageId: "lineage-1", version: 1, name: "Returns", enabled: false,
  activation: { triggerDescription: "Handle returns.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" as const },
  steps: [{ stableStepId: "collect", kind: "chat", instruction: "Collect details.", toolRef: null, ordinal: 0, metadata: {} }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 1 }],
  slots: [],
  transitions: [{ fromStep: "collect", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 }],
  createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z"),
};

describe("routine enable proposal", () => {
  it("drafts and applies an enable through the routines owner's effective-draft port", async () => {
    const updateDraftForCopilotProposal = vi.fn(async () => ({ routine: { ...parkedRoutine, enabled: true } }));
    const adapter = createRoutineCopilotProposalAdapter({
      agentService: { get: vi.fn() },
      routineDraftAssistService: { draft: vi.fn() },
      routineDefinitionService: {
        get: vi.fn(async () => parkedRoutine),
        validateForDraftMutation: vi.fn(async () => ({ ok: true, diagnostics: [] })),
        validate: vi.fn(async () => ({ ok: true, diagnostics: [] })),
        updateDraftForCopilotProposal,
      } as never,
    });

    const draft = await adapter.draftEdit(workspaceId, { agentId, routineId }, { enabled: true });
    await expect(adapter.applyIfVersionMatches(workspaceId, { agentId, routineId }, draft.payload, parkedRoutine.updatedAt.toISOString()))
      .resolves.toEqual({ outcome: "applied", appliedRef: { agentId, routineId } });
    expect(updateDraftForCopilotProposal).toHaveBeenCalledWith(
      workspaceId,
      agentId,
      routineId,
      expect.objectContaining({ enabled: true }),
      { expectedUpdatedAt: parkedRoutine.updatedAt },
    );
  });
});
