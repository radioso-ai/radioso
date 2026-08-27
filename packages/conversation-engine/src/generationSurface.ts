import type { DirectiveMatch, GenerationSurface, SteeringRule } from "@radioso/conversation-contract";

/**
 * The generators a rule with no authored scope is addressed to. Historically every
 * rule addressed the answer body, so an unscoped rule keeps meaning exactly that.
 */
const DEFAULT_SURFACES: GenerationSurface[] = ["answer"];

/**
 * The generators an authored scope resolves to. Empty and absent both mean the
 * answering voice, so the two spellings are one scope everywhere downstream —
 * including rule identity, where treating them as different would render the same
 * rule twice.
 */
export const effectiveSurfaces = (
  surfaces: readonly GenerationSurface[] | undefined,
): readonly GenerationSurface[] => (surfaces?.length ? surfaces : DEFAULT_SURFACES);

/**
 * Whether a scope addresses one generator. Every consumer that acts on behalf of a
 * single generator — the prompt block that renders it, the binding that picks who
 * answers, the lifecycle memory that records what fired — asks this rather than
 * reading `surfaces` directly, so "empty means answer" has one definition.
 */
export const addressesSurface = (
  surfaces: readonly GenerationSurface[] | undefined,
  surface: GenerationSurface,
): boolean => effectiveSurfaces(surfaces).includes(surface);

/**
 * Narrows a turn's steering to the rules addressed to one generator, so each surface
 * renders the rules that govern it instead of the whole set.
 */
export const steeringForSurface = (
  rules: SteeringRule[],
  surface: GenerationSurface,
): SteeringRule[] => rules.filter((rule) => addressesSurface(rule.surfaces, surface));

/**
 * The surfaces a matched directive renders on: a host-applied bound narrowing when
 * there is one, otherwise the authored scope. Returns undefined when the scope is the
 * default, so the steering rule stays unscoped rather than carrying a redundant list.
 */
export const resolveRenderSurfaces = (match: DirectiveMatch): GenerationSurface[] | undefined => {
  const scope = match.renderSurfaces ?? match.directive.surfaces;
  return scope?.length ? [...scope] : undefined;
};
