import { buildDirectiveMatchPrompt, getDirectiveMatchSystemPrompt } from "./directiveMatchPrompt.js";
import { parseDirectiveClassifications } from "./directiveMatchParser.js";
import type {
  Directive,
  DirectiveClassification,
  DirectiveMatch,
  DirectiveMatchGateway,
  DirectiveMatchInput,
  DirectiveMatcherPort,
} from "@radioso/conversation-contract";
export type { DirectiveClassification, DirectiveMatchGateway } from "@radioso/conversation-contract";

export interface DirectiveTextGenerationClient {
  complete(input: {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
  }): Promise<{ text: string }>;
}

/** Model-backed gateway: render the prompt, call the client, parse the result. */
export class ModelDirectiveMatchGateway implements DirectiveMatchGateway {
  private readonly systemPrompt?: string;

  constructor(
    private readonly client: DirectiveTextGenerationClient,
    options: { systemPrompt?: string } = {},
  ) {
    this.systemPrompt = options.systemPrompt;
  }

  async match(input: { turnContext: Record<string, unknown>; directives: Directive[] }): Promise<DirectiveClassification[]> {
    const { text } = await this.client.complete({
      systemPrompt: getDirectiveMatchSystemPrompt(this.systemPrompt),
      prompt: buildDirectiveMatchPrompt(input),
      temperature: 0,
    });
    return parseDirectiveClassifications(text, input.directives.map((directive) => directive.name));
  }
}

/**
 * Notified when contextual classification could not be obtained for a turn and the
 * matcher degraded to zero contextual matches. Purely observational — the caller
 * has already continued without contextual directives by the time it runs, and it
 * must not throw.
 */
export type DirectiveMatchUnavailableObserver = (error: unknown) => void;

const ignoreMatchUnavailable: DirectiveMatchUnavailableObserver = () => {};

/**
 * Matches `contextual` directives by asking the gateway which conditions hold,
 * then keeping those at or above the confidence threshold. Skips `always`
 * directives (the deterministic matcher owns those) and makes no model call when
 * there are no contextual directives.
 *
 * Contextual matching is an enhancement, never a precondition for answering: this
 * matcher's contribution is purely additive, so a gateway failure degrades to zero
 * contextual matches rather than failing the turn. Only this module knows its
 * matches come from a fallible model call, so degradation is owned here and not in
 * the composite, which cannot tell an optional delegate from a required one.
 */
export class ProbabilisticDirectiveMatcher implements DirectiveMatcherPort {
  private readonly gateway: DirectiveMatchGateway;
  private readonly confidenceThreshold: number;
  private readonly onMatchUnavailable: DirectiveMatchUnavailableObserver;

  constructor(deps: {
    gateway: DirectiveMatchGateway;
    confidenceThreshold: number;
    onMatchUnavailable?: DirectiveMatchUnavailableObserver;
  }) {
    this.gateway = deps.gateway;
    this.confidenceThreshold = deps.confidenceThreshold;
    this.onMatchUnavailable = deps.onMatchUnavailable ?? ignoreMatchUnavailable;
  }

  async match({ turnContext, directives }: DirectiveMatchInput): Promise<DirectiveMatch[]> {
    const contextual = directives.filter((directive) => directive.condition.kind === "contextual");
    if (contextual.length === 0) {
      return [];
    }

    let classifications: DirectiveClassification[];
    try {
      classifications = await this.gateway.match({ turnContext, directives: contextual });
    } catch (error) {
      this.onMatchUnavailable(error);
      return [];
    }
    const byName = new Map(contextual.map((directive) => [directive.name, directive]));

    return classifications
      .filter((classification) => classification.confidence >= this.confidenceThreshold)
      .flatMap((classification) => {
        const directive = byName.get(classification.name);
        if (!directive) {
          return [];
        }
        return [{
          directive,
          selectionMode: "probabilistic" as const,
          selectionReason: classification.reason ?? "Matched directive condition for this turn.",
          selectionConfidence: classification.confidence,
        }];
      });
  }
}
