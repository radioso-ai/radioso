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
    binding: directive.binding,
    ...(directive.lifecycle === null ? {} : { lifecycle: directive.lifecycle }),
    requiredCapabilities: directive.requiredCapabilities,
    dependsOn: directive.dependsOn,
    excludes: directive.excludes,
    // Absent rather than empty: the renderer reads an absent scope as the answering
    // voice, and an empty array would say the same thing more noisily.
    ...(directive.surfaces && directive.surfaces.length > 0 ? { surfaces: directive.surfaces } : {}),
    tags: directive.tags,
    ...(directive.description === null ? {} : { description: directive.description }),
    metadata: directive.metadata,
  };
};

const authoredDirectiveToSteeringDirective = (
  directive: AuthoredDirective,
): Directive =>
  authoredDirectiveToDirective(directive, {
    defaultPriority: AUTHORED_DIRECTIVE_STEERING_DEFAULT_PRIORITY,
  });

/**
 * The only supported way to turn an agent's authored directives into steering candidates.
 * A disabled directive keeps its authored text but must never reach the matcher — this is
 * the one place that invariant is enforced, so every call site that builds a turn's
 * candidate set goes through here rather than mapping `authoredDirectives` directly.
 */
export const steeringDirectivesFromAuthored = (
  directives: readonly AuthoredDirective[] | undefined,
): Directive[] =>
  (directives ?? [])
    .filter((directive) => directive.enabled)
    .map(authoredDirectiveToSteeringDirective);
