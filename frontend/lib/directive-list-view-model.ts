import type { BuiltInDirective, Directive, DirectiveCoherence } from './api-types'
import { directiveSurfacesOverlap } from './directive-surfaces'

type CoherenceConflict = DirectiveCoherence['conflicts'][number]

export type DirectiveConflictEntry = {
  conflict: CoherenceConflict
  // The directive the verdict was computed for: the one just saved, enabled, or resolved.
  // Every conflict in a verdict is between it and the directive the conflict names.
  subject: Directive | null
  // The authored directive the conflict names. Null when it names a built-in, which is not
  // an authored directive and so cannot be resubmitted.
  existing: Directive | null
  // The verdict's summary, shared by every conflict in it.
  rationale: string
}

type DirectiveRowBase = {
  // The authored directive's id. Rows are anchored and focused by it.
  id: string
  title: string
  directive: Directive
  // What this directive replaces, by display name: only the exclusions that name something it
  // actually meets on a generator.
  replaces: string[]
  conflicts: DirectiveConflictEntry[]
}

export type DirectiveRow =
  | (DirectiveRowBase & { kind: 'authored' })
  // A built-in that exactly one authored directive replaces, folded into that directive's row.
  | (DirectiveRowBase & { kind: 'customized'; builtIn: BuiltInDirective })

export type BuiltInDefaultEntry = {
  builtIn: BuiltInDirective
  title: string
  // The enabled authored directive whose exclusion currently fires against this built-in. A
  // contextual one only supersedes it when its condition holds; an unconditional one retires it.
  replacedBy: Directive | null
}

type DirectiveConflictBanner = {
  conflictCount: number
  rationale: string
  // The authored directive whose sheet explains the conflict, or null when none is listed.
  reviewDirectiveId: string | null
}

type DirectiveListViewModel = {
  rows: DirectiveRow[]
  defaults: BuiltInDefaultEntry[]
  banner: DirectiveConflictBanner | null
}

const builtInTitle = (builtIn: BuiltInDirective): string => builtIn.title || builtIn.name

// Built-ins govern the reply. An exclusion authored through an older API client may name one from
// a suggestion-only directive, but those rules never meet on a generator, so it replaces nothing.
const excludesBuiltIn = (directive: Directive, builtIn: BuiltInDirective): boolean =>
  (directive.excludes ?? []).includes(builtIn.name) && directiveSurfacesOverlap(directive.surfaces, undefined)

// A customization is the one directive that stands in for a built-in on every turn and for nothing
// else. Two of them, a contextual one, or one that also excludes other names is a rule in its own
// right, and folding it into the built-in's row would hide what it does.
const customizationOf = (builtIn: BuiltInDirective, directives: Directive[]): Directive | null => {
  const unconditional = directives.filter(
    (directive) => directive.condition.kind === 'always' && excludesBuiltIn(directive, builtIn),
  )
  if (unconditional.length !== 1) return null
  const [only] = unconditional
  const excluded = new Set(only.excludes ?? [])
  return excluded.size === 1 ? only : null
}

// A disabled directive never becomes a runtime directive, so its exclusion never fires and the
// built-in it names is still fully live. This is a statement about live behaviour.
const replacerOf = (builtIn: BuiltInDirective, directives: Directive[]): Directive | null =>
  directives.find((directive) => directive.enabled && excludesBuiltIn(directive, builtIn)) ?? null

const replacedNames = (
  directive: Directive,
  directives: Directive[],
  builtIns: BuiltInDirective[],
): string[] => {
  const targets = new Map<string, { label: string; surfaces: Directive['surfaces'] | undefined }>()
  for (const builtIn of builtIns) targets.set(builtIn.name, { label: builtInTitle(builtIn), surfaces: undefined })
  for (const other of directives) targets.set(other.name, { label: other.name, surfaces: other.surfaces })
  return (directive.excludes ?? []).flatMap((name) => {
    const target = targets.get(name)
    return target && directiveSurfacesOverlap(directive.surfaces, target.surfaces) ? [target.label] : []
  })
}

const conflictEntries = (
  coherence: DirectiveCoherence | null,
  directives: Directive[],
  subjectId: string | null,
): DirectiveConflictEntry[] => {
  if (!coherence || coherence.coherent) return []
  const subject = subjectId ? directives.find((directive) => directive.id === subjectId) ?? null : null
  return coherence.conflicts.map((conflict) => ({
    conflict,
    subject,
    rationale: coherence.rationale,
    existing: directives.find((directive) =>
      conflict.directiveId ? directive.id === conflict.directiveId : directive.name === conflict.directiveName,
    ) ?? null,
  }))
}

const conflictsInvolving = (
  entries: DirectiveConflictEntry[],
  directive: Directive,
  builtIn?: BuiltInDirective,
): DirectiveConflictEntry[] =>
  entries.filter((entry) =>
    entry.subject?.id === directive.id
    || entry.existing?.id === directive.id
    // A customized row stands for its built-in, so a conflict that names the built-in is
    // about this row too.
    || (builtIn !== undefined && entry.existing === null && !entry.conflict.directiveId
      && entry.conflict.directiveName === builtIn.name),
  )

export const buildDirectiveListViewModel = ({
  directives,
  builtIns,
  coherence,
  coherenceSubjectId,
}: {
  directives: Directive[]
  builtIns: BuiltInDirective[]
  coherence: DirectiveCoherence | null
  coherenceSubjectId: string | null
}): DirectiveListViewModel => {
  const entries = conflictEntries(coherence, directives, coherenceSubjectId)

  const customizations = new Map<string, BuiltInDirective>()
  for (const builtIn of builtIns) {
    const customization = customizationOf(builtIn, directives)
    if (customization) customizations.set(customization.id, builtIn)
  }

  const authoredRows: DirectiveRow[] = directives
    .filter((directive) => !customizations.has(directive.id))
    .map((directive) => ({
      kind: 'authored',
      id: directive.id,
      title: directive.name,
      directive,
      replaces: replacedNames(directive, directives, builtIns),
      conflicts: conflictsInvolving(entries, directive),
    }))

  const customizedRows: DirectiveRow[] = builtIns.flatMap((builtIn) => {
    const directive = directives.find((candidate) => customizations.get(candidate.id) === builtIn)
    return directive
      ? [{
          kind: 'customized',
          id: directive.id,
          title: builtInTitle(builtIn),
          directive,
          builtIn,
          replaces: replacedNames(directive, directives, builtIns),
          conflicts: conflictsInvolving(entries, directive, builtIn),
        } satisfies DirectiveRow]
      : []
  })

  const rows = [...authoredRows, ...customizedRows]
  const customizedNames = new Set(customizedRows.flatMap((row) => (row.kind === 'customized' ? [row.builtIn.name] : [])))
  const defaults = builtIns
    .filter((builtIn) => !customizedNames.has(builtIn.name))
    .map((builtIn) => ({ builtIn, title: builtInTitle(builtIn), replacedBy: replacerOf(builtIn, directives) }))

  const banner = coherence && !coherence.coherent
    ? {
        conflictCount: coherence.conflicts.length,
        rationale: coherence.rationale,
        reviewDirectiveId: rows.find((row) => row.conflicts.length > 0)?.id ?? null,
      }
    : null

  return { rows, defaults, banner }
}
