import type { DirectiveMatch } from "./domain.js";
import { directiveMatchConfidence, directiveMatchPriority } from "./directiveMatchRanking.js";

/**
 * Caps on how much matched directive steering renders into the answer prompt.
 * A top-k cap keeps the highest-signal directives, and a token budget bounds the
 * rendered block's size. Both are ranked by matcher confidence × priority so the
 * survivors are the ones most likely to hold this turn and matter most.
 */
export interface SteeringBoundConfig {
  maxRenderedDirectives: number;
  renderedTokenBudget: number;
}

export type SteeringBoundReason = "top_k" | "token_budget" | "unmet_dependency";

/** A matched directive dropped from the rendered steering block, with cause. */
export interface SteeringBoundDrop {
  directiveName: string;
  reason: SteeringBoundReason;
}

export interface SteeringBoundResult {
  /** Directives that render, in rank order. */
  kept: DirectiveMatch[];
  /** Directives held back by a cap or the budget, for the trace and a debug log. */
  dropped: SteeringBoundDrop[];
}

// Rank the rendered set by confidence × priority: a directive earns its place by
// both holding this turn (confidence) and mattering (priority). The primitives are
// shared with turn-skill binding — see directiveMatchRanking.
const boundScore = (match: DirectiveMatch): number =>
  directiveMatchConfidence(match) * directiveMatchPriority(match);

// A rendered steering line is roughly "- {action} (when: {condition})". Estimate
// its cost from character length at the repo-standard ~4 chars/token; exactness is
// unnecessary because the budget is a soft guard, not an accounting boundary.
const estimateTokens = (match: DirectiveMatch): number => {
  const condition =
    match.directive.condition.kind === "contextual" ? match.directive.condition.description : "";
  const chars = match.directive.action.length + condition.length;
  return Math.max(1, Math.ceil(chars / 4));
};

/**
 * Narrows a matched, relationship-resolved directive set to what should render as
 * steering. Ranks by confidence × priority to decide *membership* — keep the
 * top-k, then fill the token budget in rank order (a directive that would overflow
 * the budget, and every lower-ranked one after it, is dropped whole rather than
 * truncated). Ranking never reorders the survivors: they are returned in the
 * caller's original order so equal-priority ties keep their registration order
 * downstream. Every drop is returned so the caller can record it; nothing is
 * capped silently.
 */
export const boundSteeringMatches = (
  matches: DirectiveMatch[],
  config: SteeringBoundConfig,
): SteeringBoundResult => {
  const ranked = matches
    .map((match, index) => ({ match, index }))
    .sort((left, right) => {
      const scoreDelta = boundScore(right.match) - boundScore(left.match);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      // Equal-signal tie: keep registration order so the cap can't silently
      // reorder which equal-priority directives survive (earlier-registered wins,
      // matching the precedence the rendered block preserves).
      return left.index - right.index;
    })
    .map((entry) => entry.match);

  const keptNames = new Set<string>();
  const dropped: SteeringBoundDrop[] = [];
  let usedTokens = 0;
  let budgetExhausted = false;

  for (const [index, match] of ranked.entries()) {
    if (index >= config.maxRenderedDirectives) {
      dropped.push({ directiveName: match.directive.name, reason: "top_k" });
      continue;
    }
    const cost = estimateTokens(match);
    // Always render the top-ranked directive even if it alone exceeds the budget:
    // dropping it would leave the turn with no steering at all. Once one match
    // overflows, every lower-ranked match is held back to keep rank order intact.
    if (budgetExhausted || (keptNames.size > 0 && usedTokens + cost > config.renderedTokenBudget)) {
      budgetExhausted = true;
      dropped.push({ directiveName: match.directive.name, reason: "token_budget" });
      continue;
    }
    usedTokens += cost;
    keptNames.add(match.directive.name);
  }

  // Bounding can strip a dependency out from under a surviving dependent. The
  // dependsOn invariant is that a directive applies only when its dependencies
  // also apply, so cascade-drop any survivor whose dependency is no longer
  // rendered (to a fixpoint, so broken chains unwind fully).
  for (;;) {
    let changed = false;
    for (const match of matches) {
      if (!keptNames.has(match.directive.name)) {
        continue;
      }
      const unmet = (match.directive.dependsOn ?? []).find((dependency) => !keptNames.has(dependency));
      if (unmet !== undefined) {
        keptNames.delete(match.directive.name);
        dropped.push({ directiveName: match.directive.name, reason: "unmet_dependency" });
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  // Emit survivors in the caller's original order: ranking decided membership, but
  // the rendered block must preserve registration order so `orderSteeringRules`
  // keeps equal-priority ties stable (the steering prompt gives earlier rules
  // precedence in a conflict).
  const kept = matches.filter((match) => keptNames.has(match.directive.name));
  return { kept, dropped };
};
