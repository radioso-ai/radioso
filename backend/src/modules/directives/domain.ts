import type { SteeringCriticality, SteeringRule } from "../../shared/domain/steeringRule.js";

/**
 * A Directive is an authored, standing `condition → action` behavioral rule the
 * turn loop matches per turn and injects into answer composition to shape *how*
 * the agent behaves. It is the standing counterpart of a skill's transient
 * guidance; both unify on {@link SteeringRule}.
 *
 * Steer-Not-Act: a Directive carries condition/action + steering metadata only.
 * It has no execution descriptor, no executor, and no result channel — the
 * moment it gains a `dispatch()` it is a malformed Skill. Skills act; Directives
 * steer.
 */
export type DirectiveCondition =
  | { kind: "always" }
  | { kind: "contextual"; description: string };

export interface Directive {
  name: string;
  condition: DirectiveCondition;
  /** Instruction to the composer, LLM-consumed — never literal user-facing copy. */
  action: string;
  priority?: number;
  criticality?: SteeringCriticality;
  /** The directive is only injected if the agent holds these capabilities. */
  requiredCapabilities?: string[];
  /** This directive applies only if all of these directives also apply this turn. */
  dependsOn?: string[];
  /** When this directive applies, drop these directives from the turn. */
  excludes?: string[];
  description?: string;
}

export type DirectiveSelectionMode = "deterministic" | "probabilistic";

export interface DirectiveMatch {
  directive: Directive;
  selectionMode: DirectiveSelectionMode;
  selectionReason: string;
  selectionConfidence?: number;
}

export interface DirectiveOmission {
  directiveName: string;
  reason: string;
}

/** Maps a matched Directive into a directive-sourced, response-lifespan SteeringRule. */
export const directiveToSteeringRule = (match: DirectiveMatch): SteeringRule => ({
  action: match.directive.action,
  condition: match.directive.condition.kind === "contextual"
    ? match.directive.condition.description
    : undefined,
  priority: match.directive.priority,
  criticality: match.directive.criticality,
  description: match.directive.description,
  source: "directive",
  lifespan: "response",
});

/**
 * Resolves directive relationships over the matched set to keep the injected set
 * narrow — the lever that lets many directives coexist without crowding the
 * prompt. Two relationships, applied in order:
 *
 * 1. **excludes** — a directive that applies drops the directives it excludes.
 *    Processed in priority order (higher priority wins a mutual exclusion), so
 *    resolution is deterministic.
 * 2. **dependsOn** — a directive applies only if all its dependencies also apply
 *    (after exclusions). Resolved to a fixpoint so a dropped dependency cascades.
 *
 * Pure: returns the kept matches and an omission per dropped directive with a
 * reason (`excluded_by:<name>` / `unmet_dependency:<name>`), for the trace.
 */
export const resolveDirectiveRelationships = (
  matches: DirectiveMatch[],
): { kept: DirectiveMatch[]; omissions: DirectiveOmission[] } => {
  const omissions: DirectiveOmission[] = [];
  const present = new Set(matches.map((match) => match.directive.name));

  const excluded = new Set<string>();
  const byPriority = [...matches].sort((a, b) => (b.directive.priority ?? 0) - (a.directive.priority ?? 0));
  for (const match of byPriority) {
    if (excluded.has(match.directive.name)) {
      continue;
    }
    for (const target of match.directive.excludes ?? []) {
      if (target !== match.directive.name && present.has(target) && !excluded.has(target)) {
        excluded.add(target);
        omissions.push({ directiveName: target, reason: `excluded_by:${match.directive.name}` });
      }
    }
  }

  let survivors = matches.filter((match) => !excluded.has(match.directive.name));
  for (;;) {
    const survivingNames = new Set(survivors.map((match) => match.directive.name));
    const next = survivors.filter((match) => {
      const unmet = (match.directive.dependsOn ?? []).find((dependency) => !survivingNames.has(dependency));
      if (unmet !== undefined) {
        omissions.push({ directiveName: match.directive.name, reason: `unmet_dependency:${unmet}` });
        return false;
      }
      return true;
    });
    if (next.length === survivors.length) {
      break;
    }
    survivors = next;
  }

  return { kept: survivors, omissions };
};
