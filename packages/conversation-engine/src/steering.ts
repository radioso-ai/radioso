import type {
  ConversationTraceStage,
  Directive,
  DirectiveMatch,
  ProcessTurnInput,
  SteeringResolver,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";
import { effectiveSurfaces, resolveRenderSurfaces } from "./generationSurface.js";
import { timedStage } from "./traceStages.js";
import { summarizeDirectiveMatch } from "./traceSummaries.js";

export const directiveMatchToSteering = (match: DirectiveMatch): SteeringRule => ({
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

export const isDirectiveEligibleForTurn = (directive: Directive, turnContext: TurnContext): boolean => {
  for (const tag of directive.tags ?? []) {
    if (tag.startsWith("routine:")) {
      const routineId = tag.slice("routine:".length);
      if (!routineId || turnContext.activeRoutineId !== routineId) {
        return false;
      }
      continue;
    }

    if (tag.startsWith("step:")) {
      const [routineId, stepId, extra] = tag.slice("step:".length).split(":");
      if (
        extra !== undefined
        || !routineId
        || !stepId
        || turnContext.activeRoutineId !== routineId
        || turnContext.activeStepId !== stepId
      ) {
        return false;
      }
    }
  }

  return true;
};

export class DefaultSteeringResolver implements SteeringResolver {
  resolve(rules: SteeringRule[], _ctx: { turnContext: TurnContext }): SteeringRule[] {
    const indexed = rules.map((rule, index) => ({ rule, index }));
    const base = indexed.filter(({ rule }) => rule.source !== "directive");
    const directives = indexed
      .filter(({ rule }) => rule.source === "directive")
      .sort((a, b) => {
        const priorityDelta = (b.rule.priority ?? 0) - (a.rule.priority ?? 0);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        return a.index - b.index;
      });

    const seen = new Set<string>();
    const resolved: SteeringRule[] = [];
    for (const { rule } of [...base, ...directives]) {
      // Scope is part of a rule's identity: the same action addressed to two
      // generators is two rules, and collapsing them would leave one generator
      // unsteered. Normalized so an absent scope and an explicit ["answer"] are
      // one key rather than a duplicate render.
      const scope = [...effectiveSurfaces(rule.surfaces)].sort().join(",");
      const key = `${rule.action}\u0000${rule.condition ?? ""}\u0000${scope}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      resolved.push(rule);
    }
    return resolved;
  }
}

const defaultSteeringResolver = new DefaultSteeringResolver();

const buildDirectiveTraceStage = (input: {
  id: string;
  kind: string;
  matches: DirectiveMatch[];
  candidateCount: number;
  scopeFilteredCount?: number;
  startedAtMs: number;
  completedAtMs: number;
}): ConversationTraceStage => timedStage(input.startedAtMs, input.completedAtMs, {
  id: input.id,
  kind: input.kind,
  status: input.matches.length > 0 ? "applied" : "skipped",
  outputs: {
    matchCount: input.matches.length,
    directives: input.matches.map(summarizeDirectiveMatch),
    candidateCount: input.candidateCount,
    ...(input.scopeFilteredCount !== undefined ? { scopeFilteredCount: input.scopeFilteredCount } : {}),
  },
});

export const buildResolvedSteering = async (input: {
  turn: TurnContext;
  directives?: ProcessTurnInput["directives"];
  directiveMatcher?: ProcessTurnInput["directiveMatcher"];
  steeringResolver?: SteeringResolver;
  baseSteering?: SteeringRule[];
  traceKind?: string;
}): Promise<{ steering: SteeringRule[]; directiveMatches: DirectiveMatch[]; traceStage: ConversationTraceStage }> => {
  const startedAtMs = Date.now();
  const directives = input.directives ?? [];
  const eligibleDirectives = directives.filter((directive) => isDirectiveEligibleForTurn(directive, input.turn));
  const directiveMatches = input.directiveMatcher
    ? await input.directiveMatcher.match({ turn: input.turn, directives: eligibleDirectives })
    : [];
  // A host may retain a match for trace and directive-to-skill binding after its
  // steering bound withheld it from every generator. Never rebuild those retained
  // diagnostics into an engine-owned routine or clarification prompt.
  const directiveSteering = directiveMatches
    .filter((match) => match.renderInSteering !== false)
    .map(directiveMatchToSteering);
  const combined = [...(input.baseSteering ?? []), ...directiveSteering];
  const steering = (input.steeringResolver ?? defaultSteeringResolver).resolve(combined, {
    turnContext: input.turn,
  });
  const completedAtMs = Date.now();

  return {
    steering,
    directiveMatches,
    traceStage: buildDirectiveTraceStage({
      id: input.traceKind === "directive_steering" ? "directive_steering" : "directives",
      kind: input.traceKind ?? "directive_match",
      matches: directiveMatches,
      candidateCount: eligibleDirectives.length,
      scopeFilteredCount: directives.length - eligibleDirectives.length,
      startedAtMs,
      completedAtMs,
    }),
  };
};
