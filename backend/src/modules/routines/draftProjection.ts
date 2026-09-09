import type { RoutineDefinition } from "./domain.js";

/**
 * The routine view stored in an agent draft. A lineage has one operator-selected
 * definition: its editable revision when one exists, otherwise its currently
 * published definition. Superseded and archived definitions remain available to
 * pinned conversations but are never part of a new draft/candidate graph.
 */
export const selectDraftRoutineDefinitions = (
  definitions: readonly RoutineDefinition[],
): RoutineDefinition[] => {
  const selected = new Map<string, RoutineDefinition>();

  for (const definition of definitions) {
    if (definition.status !== "draft" && definition.status !== "published") {
      continue;
    }
    const current = selected.get(definition.lineageId);
    if (!current ||
      (definition.status === "draft" && current.status !== "draft") ||
      (definition.status === current.status && definition.version > current.version)
    ) {
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
 * Normalized directive tags remain attached to the currently published routine
 * while an operator edits its next definition. A candidate instead carries the
 * selected draft definition, so its immutable directive view must follow that
 * lineage without changing authoring storage before local routine publish.
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
