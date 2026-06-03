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
import type { TextGenerationClient } from "../../shared/infra/llm/providerTypes.js";

import { DirectiveSteeringService, type DirectiveSteeringPort } from "./directiveSteeringService.js";
import type { Directive } from "./domain.js";

/**
 * Builds the directive matcher. Always includes the deterministic always-match
 * matcher; adds the probabilistic contextual matcher when a text-generation
 * client is supplied. When the standing set has no contextual directives, the
 * probabilistic matcher makes no model call.
 */
export const createDirectiveMatcher = (input: {
  textGenerationClient?: TextGenerationClient;
  confidenceThreshold?: number;
}): DirectiveMatcherPort => {
  const alwaysMatch = new AlwaysMatchDirectiveMatcher();
  if (!input.textGenerationClient) {
    return alwaysMatch;
  }
  return new CompositeDirectiveMatcher([
    alwaysMatch,
    new ProbabilisticDirectiveMatcher({
      gateway: new ModelDirectiveMatchGateway(input.textGenerationClient),
      confidenceThreshold: input.confidenceThreshold ?? DIRECTIVES_BEHAVIOR.contextualMatchConfidenceThreshold,
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
