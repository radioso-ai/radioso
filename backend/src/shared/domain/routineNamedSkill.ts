/**
 * An enabled skill a routine may call by name: the one filter the routine authoring catalog, the
 * routine skill resolvers, and the notice destinations share, so what an author can pick is what runs.
 */
export const isRoutineNamedSkill = (skill: { enabled: boolean; invocationMode: string }): boolean =>
  skill.enabled && skill.invocationMode === "routine_named";
