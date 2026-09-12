import type { RoutineDefinition } from "./domain.js";

/**
 * The routine view stored in an agent draft: one definition per lineage, its highest
 * version. Nothing branches a lineage any more, so this only collapses history authored
 * before routines became a single editable area. Those older rows remain available to a
 * pinned conversation but are never part of a new draft or candidate graph.
 */
export const selectCanonicalRoutineDefinitions = (
  definitions: readonly RoutineDefinition[],
): RoutineDefinition[] => {
  const selected = new Map<string, RoutineDefinition>();

  for (const definition of definitions) {
    const current = selected.get(definition.lineageId);
    if (!current || definition.version > current.version) {
      selected.set(definition.lineageId, definition);
    }
  }

  return [...selected.values()].sort((left, right) =>
    right.activation.priority - left.activation.priority ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  );
};

/**
 * A directive scope tag authored before routines collapsed to one row can still name a
 * definition its lineage branched past. The snapshot carries only the canonical definition,
 * so the immutable directive view has to follow the lineage rather than the stored id. It is
 * a no-op once the two agree, which is the steady state for anything authored since.
 */
export const projectDirectiveScopeTagsForSelectedRoutines = <T extends { tags: readonly string[] }>(
  directives: readonly T[],
  definitions: readonly RoutineDefinition[],
  selected: readonly RoutineDefinition[],
): T[] => {
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const selectedByLineage = new Map(selected.map((definition) => [definition.lineageId, definition]));

  return directives.map((directive) => ({
    ...directive,
    tags: directive.tags.map((tag) => {
      const routineMatch = /^routine:([0-9a-f-]{36})$/iu.exec(tag);
      const stepMatch = /^step:([0-9a-f-]{36}):(.+)$/iu.exec(tag);
      const definitionId = routineMatch?.[1] ?? stepMatch?.[1];
      if (!definitionId) return tag;
      const source = definitionById.get(definitionId);
      const target = source ? selectedByLineage.get(source.lineageId) : undefined;
      if (!target || target.id === definitionId) return tag;
      if (routineMatch) return `routine:${target.id}`;
      const stepId = stepMatch![2];
      // Do not invent a target for a removed step. Retaining the old tag lets
      // candidate validation reject the incomplete scope closure explicitly.
      return target.steps.some((step) => step.stableStepId === stepId)
        ? `step:${target.id}:${stepId}`
        : tag;
    }),
  }));
};
