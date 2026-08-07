import {
  AlwaysMatchDirectiveMatcher,
  CompositeDirectiveMatcher,
  DirectiveCatalogRegistry,
  ModelDirectiveMatchGateway,
  ProbabilisticDirectiveMatcher,
  type DirectiveMatcherPort,
} from "@radioso/conversation-defaults";
import { DIRECTIVES_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import { loadPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";
import type { TextGenerationClient } from "../../shared/infra/llm/providerTypes.js";

import { reportContextualMatchUnavailable } from "./contextualMatchLogging.js";
import {
  DirectiveSteeringService,
  type DirectiveSteeringLogger,
  type DirectiveSteeringPort,
} from "./directiveSteeringService.js";
import type { Directive } from "./domain.js";

/**
 * Builds the directive matcher. Always includes the deterministic always-match
 * matcher; adds the probabilistic contextual matcher when a text-generation
 * client is supplied. When the standing set has no contextual directives, the
 * probabilistic matcher makes no model call.
 *
 * The contextual half is optional at runtime as well as at construction: when its
 * model call fails the matcher yields no contextual matches and the turn proceeds
 * on the deterministic ones. The matcher carries no turn identity, so only the
 * failure itself is logged here; workspace-scoped reporting belongs to the
 * per-turn construction sites.
 */
export const createDirectiveMatcher = (input: {
  textGenerationClient?: TextGenerationClient;
  confidenceThreshold?: number;
  logger?: DirectiveSteeringLogger;
}): DirectiveMatcherPort => {
  const alwaysMatch = new AlwaysMatchDirectiveMatcher();
  if (!input.textGenerationClient) {
    return alwaysMatch;
  }
  return new CompositeDirectiveMatcher([
    alwaysMatch,
    new ProbabilisticDirectiveMatcher({
      gateway: new ModelDirectiveMatchGateway(input.textGenerationClient, {
        systemPrompt: loadPromptTemplate("chat/directive-match.md"),
      }),
      confidenceThreshold: input.confidenceThreshold ?? DIRECTIVES_BEHAVIOR.contextualMatchConfidenceThreshold,
      onMatchUnavailable: reportContextualMatchUnavailable({
        ...(input.logger ? { logger: input.logger } : {}),
        source: "model_gateway",
      }),
    }),
  ]);
};

/**
 * Builds the default directive steering port for an agent. The standing set is
 * supplied by application composition; per-agent or module-provided sets are
 * wired here, never inside the chat turn loop.
 */
export const createDirectiveSteering = (input: {
  capabilityPolicy: CapabilityPolicy;
  directives?: Directive[];
  matcher?: DirectiveMatcherPort;
  textGenerationClient?: TextGenerationClient;
}): DirectiveSteeringPort =>
  new DirectiveSteeringService({
    registry: new DirectiveCatalogRegistry(input.directives ?? []),
    matcher: input.matcher ?? createDirectiveMatcher({ textGenerationClient: input.textGenerationClient }),
    capabilityPolicy: input.capabilityPolicy,
  });
