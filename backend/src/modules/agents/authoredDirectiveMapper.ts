import type { Directive } from "../directives/public.js";
import type { AuthoredDirective, NormalizedAuthoredDirectiveInput } from "./authoredDirectives.js";

export const AUTHORED_DIRECTIVE_STEERING_DEFAULT_PRIORITY = 50;

export interface AuthoredDirectiveMappingOptions {
  defaultPriority?: number;
}

export const authoredDirectiveToDirective = (
  directive: AuthoredDirective | NormalizedAuthoredDirectiveInput,
  options: AuthoredDirectiveMappingOptions = {},
): Directive => {
  const priority = "priority" in directive ? directive.priority : null;
  return {
    ...("id" in directive ? { id: directive.id } : {}),
    name: directive.name,
    condition: directive.condition,
    action: directive.action,
    ...(priority === null
      ? options.defaultPriority === undefined ? {} : { priority: options.defaultPriority }
      : { priority }),
    requiredCapabilities: directive.requiredCapabilities,
    dependsOn: directive.dependsOn,
    excludes: directive.excludes,
    tags: directive.tags,
    ...(directive.description === null ? {} : { description: directive.description }),
    metadata: directive.metadata,
  };
};

export const authoredDirectiveToSteeringDirective = (
  directive: AuthoredDirective,
): Directive =>
  authoredDirectiveToDirective(directive, {
    defaultPriority: AUTHORED_DIRECTIVE_STEERING_DEFAULT_PRIORITY,
  });
