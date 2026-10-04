import { describe, expect, it, vi } from "vitest";

import { createRoutineScopedReferenceGuard } from "../../../src/modules/agents/routineScopedReferenceGuard.js";
import { AppError } from "../../../src/shared/domain/errors.js";

describe("createRoutineScopedReferenceGuard", () => {
  it("refuses a removed step still scoped by a directive with a named refusal, not a stale conflict or not-found", async () => {
    const buildStepScopeTag = (routineId: string, stableStepId: string) => `routine:${routineId}:step:${stableStepId}`;
    const guard = createRoutineScopedReferenceGuard({
      listDirectiveTags: vi.fn(async () => [[buildStepScopeTag("routine-1", "step_collect")]]),
      buildStepScopeTag,
    });

    const rejection = guard.assertNoScopedReferences({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      routineId: "routine-1",
      removedNodeIds: ["step_collect"],
      removedSlotIds: [],
    });

    await expect(rejection).rejects.toBeInstanceOf(AppError);
    await expect(rejection).rejects.toMatchObject({ statusCode: 400, code: "bad_request" });
    await expect(rejection).rejects.toThrow(/step_collect/);
  });

  it("allows a removal no directive scopes", async () => {
    const guard = createRoutineScopedReferenceGuard({
      listDirectiveTags: vi.fn(async () => [["routine:routine-1:step:other_step"]]),
      buildStepScopeTag: (routineId, stableStepId) => `routine:${routineId}:step:${stableStepId}`,
    });

    await expect(guard.assertNoScopedReferences({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      routineId: "routine-1",
      removedNodeIds: ["step_collect"],
      removedSlotIds: [],
    })).resolves.toBeUndefined();
  });

  it("skips the directive-tag lookup entirely when nothing was removed", async () => {
    const listDirectiveTags = vi.fn();
    const guard = createRoutineScopedReferenceGuard({ listDirectiveTags, buildStepScopeTag: vi.fn() });

    await expect(guard.assertNoScopedReferences({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      routineId: "routine-1",
      removedNodeIds: [],
      removedSlotIds: [],
    })).resolves.toBeUndefined();
    expect(listDirectiveTags).not.toHaveBeenCalled();
  });
});
