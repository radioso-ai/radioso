import type { DirectiveMatchInput, DirectiveMatcherPort, DirectiveMatch } from "@radioso/conversation-contract";
export type { DirectiveMatchInput, DirectiveMatcherPort } from "@radioso/conversation-contract";

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
