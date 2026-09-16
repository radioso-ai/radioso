import type {
  AnswerCoverageAssessment,
  AnswerCoverageCriteria,
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

type AssessedCoverage = Extract<AnswerCoverageAssessment, { availability: "assessed" }>;

/** Shared by the coverage verdict sink's reaction accounting and {@link steeringForKnownVerdict}. */
export const coverageCriteriaMatches = (
  criteria: AnswerCoverageCriteria,
  assessment: AssessedCoverage,
): boolean =>
  criteria.coverage.includes(assessment.coverage)
  && (criteria.reasons === undefined || criteria.reasons.includes(assessment.reason));

/**
 * Rewrites coverage-gated steering rules for a prompt composed for a model that
 * will never itself emit a `coverage` field (#1260 review round 3, Q3): a rule
 * still tagged with `coverageCriteria` renders as a condition on a classification
 * (`renderSteeringRules`'s "Only when your coverage verdict is one of [...]")
 * that only makes sense to the model being asked to commit that classification.
 * Two callers hit this: the pre-retrieval routine-activation clarifier, which
 * runs before any verdict can exist, and the coverage-offer clarifier inside the
 * compose-time sink, which already has one. Given the known verdict (or `undefined`
 * when none exists yet), a matching rule renders as a plain, unconditional
 * instruction; a non-matching rule, or every coverage rule when there is no
 * verdict at all, is dropped rather than rendered as a condition that call's
 * model can never evaluate. Rules without `coverageCriteria` pass through
 * unchanged.
 */
/**
 * The coverage verdict sink stashes the turn's assessed head under this metadata
 * key once it exists (`assessedComposeTurn` in coverageVerdictSink.ts). A turn
 * with no verdict yet — a pre-retrieval clarification, or a fresh non-coverage
 * turn context — reads back `undefined` here, which is exactly the "no verdict"
 * case {@link steeringForKnownVerdict} already handles.
 */
export const knownAnswerCoverage = (turn: TurnContext): AnswerCoverageAssessment | undefined => {
  const value = turn.metadata?.answerCoverage;
  return typeof value === "object" && value !== null && typeof (value as { availability?: unknown }).availability === "string"
    ? (value as AnswerCoverageAssessment)
    : undefined;
};

export const steeringForKnownVerdict = (
  rules: readonly SteeringRule[],
  assessment: AnswerCoverageAssessment | undefined,
): SteeringRule[] =>
  rules.flatMap((rule) => {
    if (!rule.coverageCriteria) {
      return [rule];
    }
    if (!assessment || assessment.availability !== "assessed") {
      return [];
    }
    if (!coverageCriteriaMatches(rule.coverageCriteria, assessment)) {
      return [];
    }
    const { coverageCriteria: _coverageCriteria, ...plainRule } = rule;
    return [plainRule];
  });

/**
 * Maps a matched Directive into a directive-sourced, response-lifespan SteeringRule.
 * `@radioso/conversation-defaults` re-exports this as `directiveToSteeringRule` rather
 * than duplicating it — defaults already depends on the engine (for
 * `resolveRenderSurfaces`), and the engine cannot depend back on defaults without a
 * cycle, so the engine is the lower package and owns this mapper.
 */
export const directiveMatchToSteering = (match: DirectiveMatch): SteeringRule => ({
  ...(match.directive.id ? { id: match.directive.id } : {}),
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
  // Coverage directives are matched contextually before the verdict exists
  // (#1260): tagging the rule lets the rendering surface layer it as a
  // condition on the classification the model is about to emit.
  ...(match.directive.coverageCriteria ? { coverageCriteria: match.directive.coverageCriteria } : {}),
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
  const steering = resolveDirectiveMatches({
    turn: input.turn,
    directiveMatches,
    baseSteering: input.baseSteering,
    steeringResolver: input.steeringResolver,
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

/** Applies one common precedence pass after hosts assemble multiple match sources. */
export const resolveDirectiveMatches = (input: {
  turn: TurnContext;
  directiveMatches: readonly DirectiveMatch[];
  baseSteering?: SteeringRule[];
  steeringResolver?: SteeringResolver;
}): SteeringRule[] => {
  const directiveSteering = input.directiveMatches
    .filter((match) => match.renderInSteering !== false)
    .map(directiveMatchToSteering);
  return (input.steeringResolver ?? defaultSteeringResolver).resolve(
    [...(input.baseSteering ?? []), ...directiveSteering],
    { turnContext: input.turn },
  );
};
