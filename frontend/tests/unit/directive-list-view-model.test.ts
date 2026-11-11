import { describe, expect, it } from 'vitest'

import type { BuiltInDirective, Directive, DirectiveCoherence } from '@/lib/api'
import { buildDirectiveListViewModel } from '@/lib/directive-list-view-model'

const now = '2026-08-28T00:00:00.000Z'

const directive = (input: Pick<Directive, 'id' | 'name'> & Partial<Directive>): Directive => {
  const { id, name, ...overrides } = input
  return {
    id,
    agentId: 'agent-1',
    name,
    condition: { kind: 'always' },
    action: `${name} instruction`,
    priority: null,
    requiredCapabilities: [],
    dependsOn: [],
    excludes: [],
    surfaces: [],
    routes: [],
    tags: [],
    description: null,
    binding: null,
    lifecycle: null,
    metadata: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const builtIn = (name: string, title = `${name} title`): BuiltInDirective => ({
  name,
  title,
  condition: { kind: 'always' },
  action: `${name} instruction`,
  priority: 50,
  description: null,
})

const formatting = builtIn('formatting', 'Readable formatting')
const links = builtIn('links', 'Inline source links')
const builtIns = [formatting, links]

const coherent: DirectiveCoherence = { coherent: true, conflicts: [], rationale: 'No conflicts.' }

const build = (
  directives: Directive[],
  options: { coherence?: DirectiveCoherence | null; subjectId?: string | null } = {},
) =>
  buildDirectiveListViewModel({
    directives,
    builtIns,
    coherence: options.coherence ?? null,
    coherenceSubjectId: options.subjectId ?? null,
  })

describe('buildDirectiveListViewModel grouping', () => {
  it('lists every built-in under defaults when nothing replaces it', () => {
    const view = build([directive({ id: 'a', name: 'Tone' })])

    expect(view.rows.map((row) => [row.kind, row.directive.name])).toEqual([['authored', 'Tone']])
    expect(view.defaults.map((entry) => entry.builtIn.name)).toEqual(['formatting', 'links'])
    expect(view.defaults.every((entry) => entry.replacedBy === null)).toBe(true)
  })

  it('folds one unconditional replacer into a customized row titled with the built-in', () => {
    const override = directive({ id: 'o', name: 'Override: formatting', excludes: ['formatting'] })
    const view = build([override])

    expect(view.rows).toHaveLength(1)
    expect(view.rows[0]).toMatchObject({
      kind: 'customized',
      id: 'o',
      title: 'Readable formatting',
      directive: { id: 'o' },
      builtIn: { name: 'formatting' },
    })
    expect(view.defaults.map((entry) => entry.builtIn.name)).toEqual(['links'])
  })

  it('still folds a disabled replacer, which stands for using the Radioso default', () => {
    const view = build([
      directive({ id: 'o', name: 'Override: formatting', excludes: ['formatting'], enabled: false }),
    ])

    expect(view.rows[0]).toMatchObject({ kind: 'customized', directive: { enabled: false } })
    expect(view.defaults.map((entry) => entry.builtIn.name)).toEqual(['links'])
  })

  it('leaves a built-in in defaults when two directives replace it unconditionally', () => {
    const view = build([
      directive({ id: 'one', name: 'First override', excludes: ['formatting'] }),
      directive({ id: 'two', name: 'Second override', excludes: ['formatting'] }),
    ])

    expect(view.rows.map((row) => row.kind)).toEqual(['authored', 'authored'])
    const entry = view.defaults.find((candidate) => candidate.builtIn.name === 'formatting')
    expect(entry?.replacedBy?.id).toBe('one')
  })

  it('counts a disabled replacer toward the tally of unconditional replacers', () => {
    const view = build([
      directive({ id: 'one', name: 'First override', excludes: ['formatting'] }),
      directive({ id: 'two', name: 'Second override', excludes: ['formatting'], enabled: false }),
    ])

    expect(view.rows.map((row) => row.kind)).toEqual(['authored', 'authored'])
  })

  it('keeps a contextual replacer as an ordinary row and notes it on the built-in', () => {
    const contextual = directive({
      id: 'legal',
      name: 'Legal links',
      condition: { kind: 'contextual', description: 'legal policy questions' },
      excludes: ['links'],
    })
    const view = build([contextual])

    expect(view.rows.map((row) => row.kind)).toEqual(['authored'])
    const entry = view.defaults.find((candidate) => candidate.builtIn.name === 'links')
    expect(entry?.replacedBy?.id).toBe('legal')
  })

  it('folds the unconditional replacer even when a contextual one also names the built-in', () => {
    const view = build([
      directive({ id: 'o', name: 'Override: links', excludes: ['links'] }),
      directive({
        id: 'legal',
        name: 'Legal links',
        condition: { kind: 'contextual', description: 'legal policy questions' },
        excludes: ['links'],
      }),
    ])

    expect(view.rows.map((row) => [row.kind, row.id])).toEqual([
      ['authored', 'legal'],
      ['customized', 'o'],
    ])
  })

  it('keeps a replacer that also excludes other names as an ordinary row', () => {
    const view = build([
      directive({ id: 'wide', name: 'Wide override', excludes: ['formatting', 'links'] }),
    ])

    expect(view.rows.map((row) => row.kind)).toEqual(['authored'])
    expect(view.defaults.map((entry) => entry.builtIn.name)).toEqual(['formatting', 'links'])
    expect(view.defaults.map((entry) => entry.replacedBy?.id)).toEqual(['wide', 'wide'])
  })

  it('does not fold a replacer that excludes an authored directive as well', () => {
    const view = build([
      directive({ id: 'tone', name: 'Tone' }),
      directive({ id: 'wide', name: 'Wide override', excludes: ['formatting', 'Tone'] }),
    ])

    expect(view.rows.map((row) => row.kind)).toEqual(['authored', 'authored'])
  })

  it('ignores an exclusion from a directive that never meets the reply', () => {
    const view = build([
      directive({ id: 's', name: 'Suggestion rule', surfaces: ['suggested_questions'], excludes: ['formatting'] }),
    ])

    expect(view.rows.map((row) => row.kind)).toEqual(['authored'])
    const entry = view.defaults.find((candidate) => candidate.builtIn.name === 'formatting')
    expect(entry?.replacedBy).toBeNull()
  })

  it('does not report a disabled replacer as retiring a built-in that stays in defaults', () => {
    const view = build([
      directive({ id: 'one', name: 'First', excludes: ['formatting', 'links'], enabled: false }),
    ])

    expect(view.defaults.every((entry) => entry.replacedBy === null)).toBe(true)
  })

  it('orders authored rows as given, then customized rows by built-in order', () => {
    const view = build([
      directive({ id: 'links-override', name: 'Override: links', excludes: ['links'] }),
      directive({ id: 'a', name: 'Alpha' }),
      directive({ id: 'formatting-override', name: 'Override: formatting', excludes: ['formatting'] }),
      directive({ id: 'b', name: 'Beta' }),
    ])

    expect(view.rows.map((row) => row.id)).toEqual(['a', 'b', 'formatting-override', 'links-override'])
    expect(view.defaults).toEqual([])
  })

  it('falls back to the built-in name when the API sends no title', () => {
    const untitled = { ...formatting, title: '' }
    const view = buildDirectiveListViewModel({
      directives: [directive({ id: 'o', name: 'Override', excludes: ['formatting'] })],
      builtIns: [untitled],
      coherence: null,
      coherenceSubjectId: null,
    })

    expect(view.rows[0]).toMatchObject({ kind: 'customized', title: 'formatting' })
  })
})

describe('buildDirectiveListViewModel conflicts', () => {
  const tone = directive({ id: 'tone', name: 'Tone' })
  const brief = directive({ id: 'brief', name: 'Brief' })
  const calm = directive({ id: 'calm', name: 'Calm' })

  it('shows no banner and flags nothing for a coherent verdict or none at all', () => {
    expect(build([tone]).banner).toBeNull()

    const view = build([tone], { coherence: coherent, subjectId: 'tone' })
    expect(view.banner).toBeNull()
    expect(view.rows.every((row) => row.conflicts.length === 0)).toBe(true)
  })

  it('flags the subject and the directive its conflict names, and opens the first flagged row', () => {
    const view = build([calm, tone, brief], {
      subjectId: 'brief',
      coherence: {
        coherent: false,
        rationale: 'They pull apart.',
        conflicts: [{ directiveId: 'tone', directiveName: 'Tone', reason: 'Opposite lengths.' }],
      },
    })

    expect(view.rows.map((row) => [row.id, row.conflicts.length])).toEqual([
      ['calm', 0],
      ['tone', 1],
      ['brief', 1],
    ])
    expect(view.banner).toEqual({
      conflictCount: 1,
      rationale: 'They pull apart.',
      reviewDirectiveId: 'tone',
    })
  })

  it('hands each flagged row the conflict with its subject and counterpart resolved', () => {
    const view = build([tone, brief], {
      subjectId: 'brief',
      coherence: {
        coherent: false,
        rationale: 'They pull apart.',
        conflicts: [{ directiveId: 'tone', directiveName: 'Tone', reason: 'Opposite lengths.' }],
      },
    })

    for (const row of view.rows) {
      expect(row.conflicts[0].rationale).toBe('They pull apart.')
      expect(row.conflicts).toHaveLength(1)
      expect(row.conflicts[0].subject?.id).toBe('brief')
      expect(row.conflicts[0].existing?.id).toBe('tone')
      expect(row.conflicts[0].conflict.reason).toBe('Opposite lengths.')
    }
  })

  it('matches a conflict to a directive by name when it carries no id', () => {
    const view = build([tone, brief], {
      subjectId: 'brief',
      coherence: {
        coherent: false,
        rationale: '',
        conflicts: [{ directiveName: 'Tone', reason: 'Opposite lengths.' }],
      },
    })

    expect(view.rows.find((row) => row.id === 'tone')?.conflicts).toHaveLength(1)
  })

  it('flags only the subject when the conflict names a built-in that stays in defaults', () => {
    const view = build([brief, tone], {
      subjectId: 'brief',
      coherence: {
        coherent: false,
        rationale: 'May conflict with a formatting rule.',
        conflicts: [{ directiveName: 'formatting', reason: 'Opposite lengths.' }],
      },
    })

    expect(view.rows.map((row) => [row.id, row.conflicts.length])).toEqual([
      ['brief', 1],
      ['tone', 0],
    ])
    expect(view.rows[0].conflicts[0].existing).toBeNull()
    expect(view.banner?.reviewDirectiveId).toBe('brief')
  })

  it('flags the customized row of a built-in that a conflict names', () => {
    const override = directive({ id: 'o', name: 'Override: formatting', excludes: ['formatting'] })
    const view = build([brief, override], {
      subjectId: 'brief',
      coherence: {
        coherent: false,
        rationale: '',
        conflicts: [{ directiveName: 'formatting', reason: 'Opposite lengths.' }],
      },
    })

    expect(view.rows.map((row) => [row.id, row.conflicts.length])).toEqual([
      ['brief', 1],
      ['o', 1],
    ])
  })

  it('counts every conflict in the verdict', () => {
    const view = build([tone, brief, calm], {
      subjectId: 'brief',
      coherence: {
        coherent: false,
        rationale: '',
        conflicts: [
          { directiveId: 'tone', directiveName: 'Tone', reason: 'One.' },
          { directiveId: 'calm', directiveName: 'Calm', reason: 'Two.' },
        ],
      },
    })

    expect(view.banner?.conflictCount).toBe(2)
    expect(view.rows.find((row) => row.id === 'brief')?.conflicts).toHaveLength(2)
  })

  it('shows a banner without a review target when the verdict names nothing that is listed', () => {
    const view = build([tone], {
      subjectId: 'deleted',
      coherence: {
        coherent: false,
        rationale: 'Something may conflict.',
        conflicts: [],
      },
    })

    expect(view.banner).toEqual({
      conflictCount: 0,
      rationale: 'Something may conflict.',
      reviewDirectiveId: null,
    })
  })
})

describe('buildDirectiveListViewModel replaces', () => {
  it('names what a row replaces, a built-in by its title', () => {
    const view = build([
      directive({ id: 'tone', name: 'Tone' }),
      directive({ id: 'wide', name: 'Wide override', excludes: ['links', 'Tone'] }),
    ])

    expect(view.rows.find((row) => row.id === 'wide')?.replaces).toEqual(['Inline source links', 'Tone'])
    expect(view.rows.find((row) => row.id === 'tone')?.replaces).toEqual([])
  })

  it('leaves out exclusions that name nothing present or never meet on a generator', () => {
    const view = build([
      directive({ id: 'tone', name: 'Tone' }),
      directive({
        id: 'suggestions',
        name: 'Suggestion rule',
        surfaces: ['suggested_questions'],
        excludes: ['links', 'Tone', 'Gone'],
      }),
    ])

    expect(view.rows.find((row) => row.id === 'suggestions')?.replaces).toEqual([])
  })
})
