import { describe, expect, it } from 'vitest'

import {
  directiveSurfacesOverlap,
  directiveSurfaceLabel,
  directiveSurfacesToForm,
  formSurfacesToPayload,
  hasUnrenderableSurface,
  toggleDirectiveSurface,
} from '@/lib/directive-surfaces'

describe('directiveSurfacesToForm', () => {
  it('reads a directive authored before the control as addressed to the reply', () => {
    expect(directiveSurfacesToForm(undefined)).toEqual(['answer'])
    expect(directiveSurfacesToForm([])).toEqual(['answer'])
  })

  it('keeps an explicit scope as authored', () => {
    expect(directiveSurfacesToForm(['suggested_questions'])).toEqual(['suggested_questions'])
    expect(directiveSurfacesToForm(['answer', 'suggested_questions'])).toEqual([
      'answer',
      'suggested_questions',
    ])
  })
})

describe('formSurfacesToPayload', () => {
  it('stores the reply alone as an empty scope', () => {
    expect(formSurfacesToPayload(['answer'])).toEqual([])
    expect(formSurfacesToPayload([])).toEqual([])
  })

  it('stores any narrower or wider scope explicitly', () => {
    expect(formSurfacesToPayload(['suggested_questions'])).toEqual(['suggested_questions'])
    expect(formSurfacesToPayload(['suggested_questions', 'answer'])).toEqual([
      'answer',
      'suggested_questions',
    ])
  })

  it('round-trips a stored scope through the form unchanged', () => {
    for (const stored of [[], ['suggested_questions'], ['answer', 'suggested_questions']] as const) {
      expect(formSurfacesToPayload(directiveSurfacesToForm([...stored]))).toEqual([...stored])
    }
  })
})

describe('toggleDirectiveSurface', () => {
  it('adds a surface that is not selected', () => {
    expect(toggleDirectiveSurface(['answer'], 'suggested_questions')).toEqual([
      'answer',
      'suggested_questions',
    ])
  })

  it('removes a selected surface while another remains', () => {
    expect(toggleDirectiveSurface(['answer', 'suggested_questions'], 'answer')).toEqual([
      'suggested_questions',
    ])
  })

  it('refuses to clear the last surface, which would address the directive to nothing', () => {
    expect(toggleDirectiveSurface(['suggested_questions'], 'suggested_questions')).toEqual([
      'suggested_questions',
    ])
  })

  it('keeps the reply selected when another form field requires it', () => {
    expect(toggleDirectiveSurface(
      ['answer', 'suggested_questions'],
      'answer',
      { answerRequired: true },
    )).toEqual(['answer', 'suggested_questions'])
  })
})

describe('directiveSurfacesOverlap', () => {
  it('treats an empty or missing scope as the reply', () => {
    expect(directiveSurfacesOverlap([], undefined)).toBe(true)
    expect(directiveSurfacesOverlap([], ['suggested_questions'])).toBe(false)
  })

  it('finds overlap only when both directives address the same generator', () => {
    expect(directiveSurfacesOverlap(
      ['answer', 'suggested_questions'],
      ['suggested_questions'],
    )).toBe(true)
    expect(directiveSurfacesOverlap(['answer'], ['suggested_questions'])).toBe(false)
  })
})

describe('directiveSurfaceLabel', () => {
  it('stays quiet for the default scope, which needs no explaining', () => {
    expect(directiveSurfaceLabel(undefined)).toBeNull()
    expect(directiveSurfaceLabel([])).toBeNull()
    expect(directiveSurfaceLabel(['answer'])).toBeNull()
  })

  it('names the generator when a directive is scoped away from the reply', () => {
    expect(directiveSurfaceLabel(['suggested_questions'])).toBe(
      'Applies to: Suggested follow-up questions',
    )
  })

  it('names both when a directive addresses both', () => {
    expect(directiveSurfaceLabel(['answer', 'suggested_questions'])).toBe(
      "Applies to: The agent's reply and Suggested follow-up questions",
    )
  })
})

describe('unknown surfaces', () => {
  const unknown = ['reading_list'] as unknown as Parameters<typeof formSurfacesToPayload>[0]

  it('carries a scope this build cannot render through a save untouched', () => {
    // Otherwise renaming a directive in an older tab silently retargets it to the reply.
    expect(formSurfacesToPayload(unknown)).toEqual(['reading_list'])
  })

  it('keeps a recognized scope alongside an unrecognized one', () => {
    const mixed = ['answer', 'reading_list'] as unknown as Parameters<typeof formSurfacesToPayload>[0]

    expect(formSurfacesToPayload(mixed)).toEqual(['answer', 'reading_list'])
  })

  it('reports a scope the editor has no control for', () => {
    expect(hasUnrenderableSurface(['reading_list'] as never)).toBe(true)
    expect(hasUnrenderableSurface(['suggested_questions'])).toBe(false)
    expect(hasUnrenderableSurface(undefined)).toBe(false)
  })
})
