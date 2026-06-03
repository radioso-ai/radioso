import type { Directive, DirectiveMatch } from "./domain.js";

export interface DirectiveMatchInput {
  /** Turn signals a matcher may inspect (query, history summary, etc.). */
  turnContext: Record<string, unknown>;
  directives: Directive[];
}

/**
 * Decides which authored Directives' conditions hold this turn. Sibling to skill
 * selection — it matches, it does not execute. The probabilistic (LLM-backed)
 * matcher is a later slice; selection MUST never be an English keyword list.
 */
export interface DirectiveMatcherPort {
  match(input: DirectiveMatchInput): Promise<DirectiveMatch[]>;
}

/**
 * Deterministic matcher for `{ kind: "always" }` directives. Resolves without a
 * model call and skips `contextual` directives (those await the probabilistic
 * matcher). This is the v1 matcher.
 */
export class AlwaysMatchDirectiveMatcher implements DirectiveMatcherPort {
  async match({ directives }: DirectiveMatchInput): Promise<DirectiveMatch[]> {
    return directives
      .filter((directive) => directive.condition.kind === "always")
      .map((directive) => ({
        directive,
        selectionMode: "deterministic" as const,
        selectionReason: "Directive condition is unconditional (always).",
      }));
  }
}
