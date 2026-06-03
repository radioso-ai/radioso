import type {
  ResolvableSkillDefinition,
  ResolvedSkillRun,
  ResolvedSkillStep,
  SkillShapeDefinition,
  SkillStepClauses,
  SkillStepOverride,
} from "./skillTypes.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const cloneValue = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
    ) as T;
  }
  return value;
};

const mergeClauses = (
  base: SkillStepClauses,
  override: SkillStepOverride | undefined,
): SkillStepClauses => {
  const merged = cloneValue(base);
  if (!override) {
    return merged;
  }

  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] = isRecord(existing) && isRecord(value)
      ? mergeClauses(existing, value)
      : cloneValue(value);
  }

  return merged;
};

export class SkillRunResolver {
  resolve(input: {
    skill: ResolvableSkillDefinition;
    shapeName?: string;
    fallbackShapeName?: string;
  }): ResolvedSkillRun {
    const fallbackShapeName = input.fallbackShapeName ?? "default";
    const requestedShapeName = input.shapeName;
    const shape =
      this.findShape(input.skill, requestedShapeName) ??
      this.findShape(input.skill, fallbackShapeName);
    const shapeName = shape?.name ?? requestedShapeName ?? fallbackShapeName;

    return {
      skillName: input.skill.name,
      shapeName,
      requestedShapeName,
      shapeFound: Boolean(shape && (!requestedShapeName || shape.name === requestedShapeName)),
      resolvedSteps: input.skill.steps.map((step): ResolvedSkillStep => {
        const appliedOverride = shape?.stepOverrides[step.name];
        return {
          name: step.name,
          kind: step.kind,
          displayName: step.displayName,
          clauses: mergeClauses(step.clauses, appliedOverride),
          overrideApplied: Boolean(appliedOverride),
          appliedOverride: appliedOverride ? cloneValue(appliedOverride) : undefined,
        };
      }),
    };
  }

  private findShape(skill: ResolvableSkillDefinition, shapeName?: string): SkillShapeDefinition | undefined {
    if (!shapeName) {
      return undefined;
    }
    return skill.shapes?.find((shape) => shape.name === shapeName);
  }
}
