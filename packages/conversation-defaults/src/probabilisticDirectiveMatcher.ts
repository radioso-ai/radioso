import { buildDirectiveMatchPrompt, getDirectiveMatchSystemPrompt } from "./directiveMatchPrompt.js";
import { parseDirectiveClassifications } from "./directiveMatchParser.js";
import type { DirectiveMatcherPort, DirectiveMatchInput } from "./directiveMatcher.js";
import type { Directive, DirectiveMatch } from "./domain.js";

/** The model's verdict that a single directive's condition holds this turn. */
export interface DirectiveClassification {
  name: string;
  confidence: number;
  reason?: string;
}

/**
 * Classifies which contextual directives apply to a turn. Narrow port so the
 * matcher is testable with a stub and the LLM wiring stays a composition detail.
 */
export interface DirectiveMatchGateway {
  match(input: { turnContext: Record<string, unknown>; directives: Directive[] }): Promise<DirectiveClassification[]>;
}

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
 * Matches `contextual` directives by asking the gateway which conditions hold,
 * then keeping those at or above the confidence threshold. Skips `always`
 * directives (the deterministic matcher owns those) and makes no model call when
 * there are no contextual directives.
 */
export class ProbabilisticDirectiveMatcher implements DirectiveMatcherPort {
  private readonly gateway: DirectiveMatchGateway;
  private readonly confidenceThreshold: number;

  constructor(deps: { gateway: DirectiveMatchGateway; confidenceThreshold: number }) {
    this.gateway = deps.gateway;
    this.confidenceThreshold = deps.confidenceThreshold;
  }

  async match({ turnContext, directives }: DirectiveMatchInput): Promise<DirectiveMatch[]> {
    const contextual = directives.filter((directive) => directive.condition.kind === "contextual");
    if (contextual.length === 0) {
      return [];
    }

    const classifications = await this.gateway.match({ turnContext, directives: contextual });
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
