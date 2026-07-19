import type { DirectiveMatch } from "./domain.js";

/**
 * Shared conventions for reading a {@link DirectiveMatch}'s rank signals. Callers
 * combine these differently — turn-skill binding is priority-first and picks one
 * winner, the steering bound blends them into a confidence × priority score to
 * rank the top-k — but the primitives below (how a directive's confidence and
 * priority are read off a match) must stay identical across both, so they live
 * here as the single source of truth rather than being copied per call site.
 */

// Neutral priority for a directive with no authored priority: an unset priority
// must not read as zero, or an unprioritised directive would sink below every
// prioritised one. Kept a plain number so both a lexicographic compare and a
// multiplicative score treat "unset" as the middle of the authored range.
export const DEFAULT_DIRECTIVE_PRIORITY = 50;

// Deterministic (always-match) directives carry no matcher confidence; treat them
// as fully confident so authored always-on steering is never ranked beneath a
// merely-probable contextual match. A probabilistic match with no recorded
// confidence reads as zero (it never cleared a threshold worth trusting).
export const directiveMatchConfidence = (match: DirectiveMatch): number =>
  match.selectionMode === "deterministic" ? 1 : match.selectionConfidence ?? 0;

export const directiveMatchPriority = (match: DirectiveMatch): number =>
  match.directive.priority ?? DEFAULT_DIRECTIVE_PRIORITY;
