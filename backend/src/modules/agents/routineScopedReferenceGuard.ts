import { badRequest } from "../../shared/domain/errors.js";

interface RoutineScopedReferenceInput {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly routineId: string;
  readonly removedNodeIds: readonly string[];
  readonly removedSlotIds: readonly string[];
}

interface RoutineScopedReferenceGuard {
  assertNoScopedReferences(input: RoutineScopedReferenceInput): Promise<void>;
}

/** Keeps routine graph removal rules with the directive owner; callers only supply a consistent read. */
export const createRoutineScopedReferenceGuard = (deps: {
  listDirectiveTags(input: Pick<RoutineScopedReferenceInput, "workspaceId" | "agentId">): Promise<ReadonlyArray<ReadonlyArray<string>>>;
  buildStepScopeTag(routineId: string, stableStepId: string): string;
}): RoutineScopedReferenceGuard => ({
  async assertNoScopedReferences(input) {
    if (input.removedNodeIds.length === 0) return;
    const tags = await deps.listDirectiveTags(input);
    for (const stableStepId of input.removedNodeIds) {
      const tag = deps.buildStepScopeTag(input.routineId, stableStepId);
      if (tags.some((directiveTags) => directiveTags.includes(tag))) {
        // A validation refusal, not a conflict: the change as authored stays invalid until the
        // directive scope is replaced, so callers must not treat it as a stale read.
        throw badRequest(`A scoped directive still references removed routine step "${stableStepId}". Replace or remove that directive scope in the same authoring change.`);
      }
    }
  },
});
