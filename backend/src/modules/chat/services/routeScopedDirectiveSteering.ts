import type { CapabilityPolicy } from "../../../shared/domain/capabilityPolicy.js";
import {
  createDirectiveMatcher,
  DirectiveSteeringService,
  type Directive,
  DirectiveCatalogRegistry,
  type DirectiveMatch,
  type DirectiveMatcherPort,
  type DirectiveSteerInput,
  type DirectiveSteeringPort,
  type DirectiveSteeringResult,
  noopDirectiveSteering,
} from "../../directives/public.js";
import { defaultAnswerDirectiveRoutes } from "./answerDirectiveRoutePolicy.js";

export interface RouteScopedDirectiveRegistration {
  directive: Directive;
  routes?: string[];
}

export type DirectiveRoutePolicy = (directive: Directive) => string[] | undefined;

export interface RouteScopedDirectiveRuntime extends DirectiveSteeringPort {
  matcher: DirectiveMatcherPort;
  directivesFor(input: DirectiveSteerInput): Directive[];
  resolveMatches(input: DirectiveSteerInput, matches: DirectiveMatch[]): Promise<DirectiveSteeringResult>;
}

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
}): RouteScopedDirectiveRuntime => {
  const matcher = input.matcher ?? createDirectiveMatcher({});
  const servicesByKey = new Map<string, DirectiveSteeringService>();
  const defaultRoutesForDirective = input.defaultRoutesForDirective ?? defaultAnswerDirectiveRoutes;

  const serviceFor = (steerInput: DirectiveSteerInput): DirectiveSteeringService => {
    const route = routeFromInput(steerInput);
    const key = route ?? "";
    let service = servicesByKey.get(key);
    if (!service) {
      service = new DirectiveSteeringService({
        capabilityPolicy: input.capabilityPolicy,
        registry: new DirectiveCatalogRegistry(directivesForRoute(input.registrations, route, defaultRoutesForDirective)),
        matcher,
      });
      servicesByKey.set(key, service);
    }
    return service;
  };

  return {
    matcher,
    directivesFor(steerInput: DirectiveSteerInput): Directive[] {
      return serviceFor(steerInput).listDirectives();
    },
    resolveMatches(
      steerInput: DirectiveSteerInput,
      matches: DirectiveMatch[],
    ): Promise<DirectiveSteeringResult> {
      return serviceFor(steerInput).resolveMatches(steerInput, matches);
    },
    async steer(steerInput: DirectiveSteerInput): Promise<DirectiveSteeringResult> {
      return serviceFor(steerInput).steer(steerInput);
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
  async resolveMatches(): Promise<DirectiveSteeringResult> {
    return { rules: [], matches: [], omissions: [] };
  },
};
