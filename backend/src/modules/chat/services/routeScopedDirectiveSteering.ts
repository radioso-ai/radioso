import type { CapabilityPolicy } from "../../../shared/domain/capabilityPolicy.js";
import {
  CompositeDirectiveMatcher,
  createDirectiveMatcher,
  DirectiveSteeringService,
  type Directive,
  DirectiveCatalogRegistry,
  type DirectiveClassification,
  type DirectiveMatch,
  type DirectiveMatchGateway,
  type DirectiveSteeringLogger,
  ProbabilisticDirectiveMatcher,
  type DirectiveMatcherPort,
  type DirectiveSteerInput,
  type DirectiveSteeringPort,
  type DirectiveSteeringResult,
  type SteeringBoundConfig,
  noopDirectiveSteering,
} from "../../directives/public.js";
import { DIRECTIVES_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { DirectiveMatchGatewayFactory } from "../../../shared/infra/llm/contextualGateways.js";
import { defaultAnswerDirectiveRoutes } from "./answerDirectiveRoutePolicy.js";

export interface RouteScopedDirectiveRegistration {
  directive: Directive;
  routes?: string[];
}

export type DirectiveRoutePolicy = (directive: Directive) => string[] | undefined;

export interface RouteScopedDirectiveRuntime extends DirectiveSteeringPort {
  matcher: DirectiveMatcherPort;
  directivesFor(input: DirectiveSteerInput): Directive[];
  matchAndResolve(input: DirectiveSteerInput, directives: Directive[]): Promise<DirectiveSteeringResult>;
  /**
   * Identical steering resolution to {@link matchAndResolve}, but consuming
   * precomputed contextual classifications instead of invoking the matcher's
   * gateway. Zero gateway calls; used by the fused turn-planning fast path.
   */
  matchAndResolveWithClassifications(
    input: DirectiveSteerInput,
    directives: Directive[],
    classifications: DirectiveClassification[],
  ): Promise<DirectiveSteeringResult>;
  resolveMatches(input: DirectiveSteerInput, matches: DirectiveMatch[]): Promise<DirectiveSteeringResult>;
}

/** A gateway that returns precomputed classifications without any model call. */
const staticClassificationGateway = (
  classifications: DirectiveClassification[],
): DirectiveMatchGateway => ({
  async match(): Promise<DirectiveClassification[]> {
    return classifications;
  },
});

const routeFromInput = (input: DirectiveSteerInput): string | null => {
  const route = input.turnContext?.route;
  return typeof route === "string" && route.length > 0 ? route : null;
};

const directivesForRoute = (
  registrations: RouteScopedDirectiveRegistration[],
  route: string | null,
  defaultRoutesForDirective: DirectiveRoutePolicy,
): Directive[] =>
  registrations
    .filter((registration) => {
      const routes = registration.routes ?? defaultRoutesForDirective(registration.directive);
      return !routes || (route !== null && routes.includes(route));
    })
    .map((registration) => registration.directive);

/**
 * Host-side directive enactment: chat owns route selection, while the Directive
 * primitive remains a pure condition/action rule.
 */
export const createRouteScopedDirectiveSteering = (input: {
  capabilityPolicy: CapabilityPolicy;
  registrations: RouteScopedDirectiveRegistration[];
  defaultRoutesForDirective?: DirectiveRoutePolicy;
  /**
   * The directive matcher to use across all routes. Supplied by application
   * composition (issue #482, part C); when omitted, `createDirectiveSteering`
   * falls back to the deterministic always-match matcher. One instance is shared
   * by every per-route service — matching is route-independent.
   */
  matcher?: DirectiveMatcherPort;
  directiveMatchGatewayFactory?: DirectiveMatchGatewayFactory;
  /** Bounds on the rendered steering set; composition-owned default when omitted. */
  steeringBound?: SteeringBoundConfig;
  logger?: DirectiveSteeringLogger;
}): RouteScopedDirectiveRuntime => {
  const matcher = input.matcher ?? createDirectiveMatcher({});
  const servicesByKey = new Map<string, DirectiveSteeringService>();
  const defaultRoutesForDirective = input.defaultRoutesForDirective ?? defaultAnswerDirectiveRoutes;
  const candidateWarningThreshold = DIRECTIVES_BEHAVIOR.steeringBound.matcherCandidateWarningThreshold;

  const serviceFor = (steerInput: DirectiveSteerInput): DirectiveSteeringService => {
    const route = routeFromInput(steerInput);
    const key = route ?? "";
    let service = servicesByKey.get(key);
    if (!service) {
      service = new DirectiveSteeringService({
        capabilityPolicy: input.capabilityPolicy,
        registry: new DirectiveCatalogRegistry(directivesForRoute(input.registrations, route, defaultRoutesForDirective)),
        matcher,
        ...(input.steeringBound ? { steeringBound: input.steeringBound } : {}),
        ...(input.logger ? { logger: input.logger } : {}),
      });
      servicesByKey.set(key, service);
    }
    return service;
  };

  // A large single-call candidate set degrades matcher recall; warn (debug) so
  // builders can split the standing set rather than silently losing matches.
  const warnOnLargeCandidateSet = (steerInput: DirectiveSteerInput, candidateCount: number): void => {
    if (candidateCount > candidateWarningThreshold) {
      input.logger?.debug(
        {
          event: "directive_matcher_large_candidate_set",
          workspaceId: steerInput.workspaceId,
          candidateCount,
          threshold: candidateWarningThreshold,
        },
        "Directive matcher candidate set exceeds recall-safe size",
      );
    }
  };

  // Single resolution body shared by both entry points. The contextual gateway is
  // an injectable classification source: when `precomputedClassifications` is
  // supplied the fused planner already ran the classification, so no gateway is
  // built and no model call is made; otherwise the per-turn gateway is created and
  // called exactly as before. The runtime remains the sole owner of resolution.
  const matchAndResolveInternal = async (
    steerInput: DirectiveSteerInput,
    directives: Directive[],
    precomputedClassifications?: DirectiveClassification[],
  ): Promise<DirectiveSteeringResult> => {
    warnOnLargeCandidateSet(steerInput, directives.length);
    const turnContext = steerInput.turnContext ?? {};
    const hasContextual = directives.some((directive) => directive.condition.kind === "contextual");
    let turnMatcher = matcher;
    if (precomputedClassifications) {
      if (hasContextual) {
        turnMatcher = new CompositeDirectiveMatcher([
          matcher,
          new ProbabilisticDirectiveMatcher({
            gateway: staticClassificationGateway(precomputedClassifications),
            confidenceThreshold: DIRECTIVES_BEHAVIOR.contextualMatchConfidenceThreshold,
          }),
        ]);
      }
    } else if (
      input.directiveMatchGatewayFactory &&
      steerInput.usageContext &&
      hasContextual
    ) {
      const gateway = await input.directiveMatchGatewayFactory.create({
        workspaceContext: { workspaceId: steerInput.workspaceId },
        usageContext: steerInput.usageContext,
      });
      turnMatcher = new CompositeDirectiveMatcher([
        matcher,
        new ProbabilisticDirectiveMatcher({
          gateway,
          confidenceThreshold: DIRECTIVES_BEHAVIOR.contextualMatchConfidenceThreshold,
        }),
      ]);
    }
    const matches = await turnMatcher.match({
      turnContext,
      directives,
    });
    return serviceFor(steerInput).resolveMatches(steerInput, matches);
  };

  return {
    matcher,
    directivesFor(steerInput: DirectiveSteerInput): Directive[] {
      const route = routeFromInput(steerInput);
      return [
        ...directivesForRoute(input.registrations, route, defaultRoutesForDirective),
        ...(steerInput.additionalDirectives ?? []),
      ];
    },
    async matchAndResolve(
      steerInput: DirectiveSteerInput,
      directives: Directive[],
    ): Promise<DirectiveSteeringResult> {
      return matchAndResolveInternal(steerInput, directives);
    },
    async matchAndResolveWithClassifications(
      steerInput: DirectiveSteerInput,
      directives: Directive[],
      classifications: DirectiveClassification[],
    ): Promise<DirectiveSteeringResult> {
      return matchAndResolveInternal(steerInput, directives, classifications);
    },
    resolveMatches(
      steerInput: DirectiveSteerInput,
      matches: DirectiveMatch[],
    ): Promise<DirectiveSteeringResult> {
      return serviceFor(steerInput).resolveMatches(steerInput, matches);
    },
    async steer(steerInput: DirectiveSteerInput): Promise<DirectiveSteeringResult> {
      const route = routeFromInput(steerInput);
      const directives = [
        ...directivesForRoute(input.registrations, route, defaultRoutesForDirective),
        ...(steerInput.additionalDirectives ?? []),
      ];
      return matchAndResolveInternal(steerInput, directives);
    },
  };
};

export const noopRouteScopedDirectiveRuntime: RouteScopedDirectiveRuntime = {
  ...noopDirectiveSteering,
  matcher: {
    async match(): Promise<DirectiveMatch[]> {
      return [];
    },
  },
  directivesFor(): Directive[] {
    return [];
  },
  async matchAndResolve(): Promise<DirectiveSteeringResult> {
    return { rules: [], matches: [], omissions: [] };
  },
  async matchAndResolveWithClassifications(): Promise<DirectiveSteeringResult> {
    return { rules: [], matches: [], omissions: [] };
  },
  async resolveMatches(): Promise<DirectiveSteeringResult> {
    return { rules: [], matches: [], omissions: [] };
  },
};
