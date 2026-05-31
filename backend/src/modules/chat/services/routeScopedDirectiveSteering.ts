import type { CapabilityPolicy } from "../../../shared/domain/capabilityPolicy.js";
import {
  createDirectiveSteering,
  type Directive,
  type DirectiveSteerInput,
  type DirectiveSteeringPort,
  type DirectiveSteeringResult,
} from "../../directives/public.js";
import { defaultAnswerDirectiveRoutes } from "./answerDirectiveRoutePolicy.js";

export interface RouteScopedDirectiveRegistration {
  directive: Directive;
  routes?: string[];
}

export type DirectiveRoutePolicy = (directive: Directive) => string[] | undefined;

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
}): DirectiveSteeringPort => {
  const servicesByKey = new Map<string, DirectiveSteeringPort>();
  const defaultRoutesForDirective = input.defaultRoutesForDirective ?? defaultAnswerDirectiveRoutes;

  return {
    async steer(steerInput: DirectiveSteerInput): Promise<DirectiveSteeringResult> {
      const route = routeFromInput(steerInput);
      const key = route ?? "";
      let service = servicesByKey.get(key);
      if (!service) {
        service = createDirectiveSteering({
          capabilityPolicy: input.capabilityPolicy,
          directives: directivesForRoute(input.registrations, route, defaultRoutesForDirective),
        });
        servicesByKey.set(key, service);
      }
      return service.steer(steerInput);
    },
  };
};
