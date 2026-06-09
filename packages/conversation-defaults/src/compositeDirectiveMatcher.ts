import type {
  DirectiveMatch,
  DirectiveMatcherPort,
  DirectiveMatchInput,
} from "@radioso/conversation-contract";

/**
 * Runs each delegate matcher and concatenates their matches. Used to combine the
 * deterministic always-match matcher with the probabilistic contextual matcher,
 * so a turn can pick up both standing and conditional directives.
 */
export class CompositeDirectiveMatcher implements DirectiveMatcherPort {
  constructor(private readonly matchers: DirectiveMatcherPort[]) {}

  async match(input: DirectiveMatchInput): Promise<DirectiveMatch[]> {
    const results = await Promise.all(this.matchers.map((matcher) => matcher.match(input)));
    return results.flat();
  }
}
