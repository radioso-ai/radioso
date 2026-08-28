import type { Directive } from './api-types'

export type DirectiveSurface = NonNullable<Directive['surfaces']>[number]

/**
 * A turn writes visitor-facing text from more than one generator, and a directive that
 * governs one does not necessarily govern another. The stored scope is empty for the
 * agent's reply alone — the meaning every directive had before this control existed —
 * so the form works in explicit choices and normalizes on the way out.
 */
export const DIRECTIVE_SURFACE_CHOICES = [
  {
    surface: 'answer',
    title: "The agent's reply",
    description: 'What the agent says back to the visitor.',
  },
  {
    surface: 'suggested_questions',
    title: 'Suggested follow-up questions',
    description: 'The questions offered to the visitor after an answer.',
  },
] as const satisfies ReadonlyArray<{ surface: DirectiveSurface; title: string; description: string }>

const REPLY_ONLY: DirectiveSurface[] = ['answer']

/** Stored scope to form scope. An empty stored scope means the reply alone. */
export const directiveSurfacesToForm = (
  surfaces: readonly DirectiveSurface[] | undefined,
): DirectiveSurface[] =>
  surfaces && surfaces.length > 0 ? [...surfaces] : [...REPLY_ONLY]

/** Replacement and competition only have meaning when two directives shape the same output. */
export const directiveSurfacesOverlap = (
  first: readonly DirectiveSurface[] | undefined,
  second: readonly DirectiveSurface[] | undefined,
): boolean => {
  const firstScope = directiveSurfacesToForm(first)
  const secondScope = directiveSurfacesToForm(second)
  return firstScope.some((surface) => secondScope.includes(surface))
}

/**
 * Form scope to stored scope. The reply alone is stored as an empty array so that a
 * directive authored here and one authored before this control read identically.
 */
export const formSurfacesToPayload = (surfaces: readonly DirectiveSurface[]): DirectiveSurface[] => {
  const known = DIRECTIVE_SURFACE_CHOICES.map((choice) => choice.surface)
  const selected = known.filter((surface) => surfaces.includes(surface))
  // A scope this build cannot render is carried through untouched. Dropping it would
  // let an unrelated edit — renaming a directive in an older tab — silently retarget a
  // rule scoped to a generator this build has not heard of.
  const unknown = surfaces.filter((surface) => !known.includes(surface))
  if (unknown.length > 0) return [...selected, ...unknown]
  if (selected.length === 0) return []
  if (selected.length === 1 && selected[0] === 'answer') return []
  return selected
}

/** True when a stored scope names a generator this build cannot show a control for. */
export const hasUnrenderableSurface = (surfaces: Directive['surfaces'] | undefined): boolean => {
  const known = DIRECTIVE_SURFACE_CHOICES.map((choice) => choice.surface)
  return (surfaces ?? []).some((surface) => !known.includes(surface))
}

/** A directive addressed to no generator would never render, so the last one cannot be cleared. */
export const toggleDirectiveSurface = (
  current: readonly DirectiveSurface[],
  surface: DirectiveSurface,
  options: { answerRequired?: boolean } = {},
): DirectiveSurface[] => {
  if (!current.includes(surface)) return [...current, surface]
  if (surface === 'answer' && options.answerRequired) return [...current]
  if (current.length === 1) return [...current]
  return current.filter((entry) => entry !== surface)
}

/**
 * How a card should label a directive's scope. The reply alone is the default and
 * needs no label; anything else is worth showing, because the same instruction reads
 * very differently depending on which generator it reaches.
 */
export const directiveSurfaceLabel = (surfaces: Directive['surfaces'] | undefined): string | null => {
  const scope = directiveSurfacesToForm(surfaces)
  if (scope.length === 1 && scope[0] === 'answer') return null
  const titles = DIRECTIVE_SURFACE_CHOICES.filter((choice) => scope.includes(choice.surface)).map(
    (choice) => choice.title,
  )
  return titles.length > 0 ? `Applies to: ${titles.join(' and ')}` : null
}
