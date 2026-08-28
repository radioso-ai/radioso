import type {
  Directive,
  DirectiveMatch,
  DirectiveSelectionMode,
  GenerationSurface,
  SteeringRule,
} from "@radioso/conversation-contract";

import { resolveRenderSurfaces } from "@radioso/conversation-engine";

export {
  addressesSurface,
  effectiveSurfaces,
  resolveRenderSurfaces,
  steeringForSurface,
} from "@radioso/conversation-engine";

export type {
  Directive,
  DirectiveCondition,
  DirectiveLifecycle,
  DirectiveMatch,
  DirectiveSelectionMode,
  GenerationSurface,
  SteeringRule,
} from "@radioso/conversation-contract";

export interface DirectiveOmission {
  directiveName: string;
  reason: string;
}

/** Maps a matched Directive into a directive-sourced, response-lifespan SteeringRule. */
export const directiveToSteeringRule = (match: DirectiveMatch): SteeringRule => ({
  directiveName: match.directive.name,
  action: match.directive.action,
  condition: match.directive.condition.kind === "contextual"
    ? match.directive.condition.description
    : undefined,
  priority: match.directive.priority,
  description: match.directive.description,
  source: "directive",
  lifespan: "response",
  ...(resolveRenderSurfaces(match) ? { surfaces: resolveRenderSurfaces(match) } : {}),
});

/**
 * Resolves directive relationships over the matched set to keep the injected set
 * narrow. Exclusions win by priority, then dependencies cascade to a fixpoint.
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

export const orderSteeringRules = (rules: SteeringRule[]): SteeringRule[] =>
  [...rules].sort((a, b) => {
    const priorityDelta = (b.priority ?? 0) - (a.priority ?? 0);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return 0;
  });
