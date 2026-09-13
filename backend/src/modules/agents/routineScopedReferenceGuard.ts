import { scopeTag } from "@radioso/conversation-defaults";

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
}): RoutineScopedReferenceGuard => ({
  async assertNoScopedReferences(input) {
    if (input.removedNodeIds.length === 0) return;
    const tags = await deps.listDirectiveTags(input);
    for (const stableStepId of input.removedNodeIds) {
      const tag = scopeTag.step(input.routineId, stableStepId);
      if (tags.some((directiveTags) => directiveTags.includes(tag))) {
        throw new Error(`A scoped directive still references removed routine step "${stableStepId}". Replace or remove that directive scope in the same authoring change.`);
      }
    }
  },
});
