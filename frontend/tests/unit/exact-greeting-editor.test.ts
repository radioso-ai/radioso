import { describe, expect, it } from 'vitest'

import {
  EXACT_GREETING_MAX_CHIPS,
  addChip,
  addVariant,
  applyEditedItem,
  codePointLength,
  createEmptyExactContent,
  extractValidationIssuesFromError,
  hasVariantForLocale,
  issuesForChipLabel,
  issuesForChips,
  issuesForVariantBody,
  issuesForVariantLocale,
  issuesForVariants,
  moveChip,
  removeChip,
  removeVariant,
  updateChipLabel,
  updateVariantBody,
} from '@/lib/exact-greeting-editor'
import type { ExactContentItem } from '@/lib/api-types'

describe('createEmptyExactContent', () => {
  it('seeds one blank variant for the agent default locale and no chips', () => {
    const item = createEmptyExactContent('en')
    expect(item).toEqual({ chips: [], variants: [{ locale: 'en', body: '', chipLabels: {} }] })
  })
})

describe('codePointLength', () => {
  it('counts a single emoji as one code point, not two UTF-16 units', () => {
    expect(codePointLength('👋')).toBe(1)
    expect('👋'.length).toBe(2)
  })

  it('counts plain ASCII the same as .length', () => {
    expect(codePointLength('hello')).toBe(5)
  })
})

describe('variant transitions', () => {
  it('adds a new-locale variant with a blank label for every existing chip', () => {
    const seeded: ExactContentItem = { chips: ['chip-1'], variants: [{ locale: 'en', body: 'Hi', chipLabels: { 'chip-1': 'Start' } }] }
    const next = addVariant(seeded, 'fr')
    expect(next.variants).toHaveLength(2)
    expect(next.variants[1]).toEqual({ locale: 'fr', body: '', chipLabels: { 'chip-1': '' } })
  })

  it('does not add a duplicate locale (case-insensitive)', () => {
    const item = createEmptyExactContent('en')
    const next = addVariant(item, 'EN')
    expect(next).toBe(item)
    expect(hasVariantForLocale(item, 'en')).toBe(true)
    expect(hasVariantForLocale(item, 'FR')).toBe(false)
  })

  it('ignores a blank locale', () => {
    const item = createEmptyExactContent('en')
    expect(addVariant(item, '   ')).toBe(item)
  })

  it('removes a variant by locale, case-insensitively', () => {
    const item = addVariant(createEmptyExactContent('en'), 'fr')
    const next = removeVariant(item, 'FR')
    expect(next.variants).toEqual([{ locale: 'en', body: '', chipLabels: {} }])
  })

  it('updates only the targeted variant body', () => {
    const item = addVariant(createEmptyExactContent('en'), 'fr')
    const next = updateVariantBody(item, 'fr', 'Bonjour')
    expect(next.variants.find((v) => v.locale === 'fr')?.body).toBe('Bonjour')
    expect(next.variants.find((v) => v.locale === 'en')?.body).toBe('')
  })
})

describe('chip transitions', () => {
  it('adds a chip with a generated id and a blank label on every variant', () => {
    const item = addVariant(createEmptyExactContent('en'), 'fr')
    const next = addChip(item)
    expect(next.chips).toHaveLength(1)
    const [chipId] = next.chips
    expect(typeof chipId).toBe('string')
    expect(chipId.length).toBeGreaterThan(0)
    for (const variant of next.variants) {
      expect(variant.chipLabels[chipId]).toBe('')
    }
  })

  it('refuses to add a 6th chip', () => {
    let item = createEmptyExactContent('en')
    for (let i = 0; i < EXACT_GREETING_MAX_CHIPS; i += 1) {
      item = addChip(item)
    }
    expect(item.chips).toHaveLength(EXACT_GREETING_MAX_CHIPS)
    const next = addChip(item)
    expect(next).toBe(item)
    expect(next.chips).toHaveLength(EXACT_GREETING_MAX_CHIPS)
  })

  it('removes a chip and its label from every variant', () => {
    const withVariant = addVariant(createEmptyExactContent('en'), 'fr')
    const withChip = addChip(withVariant)
    const [chipId] = withChip.chips
    const next = removeChip(withChip, chipId)
    expect(next.chips).toEqual([])
    for (const variant of next.variants) {
      expect(Object.keys(variant.chipLabels)).not.toContain(chipId)
    }
  })

  it('moves a chip up and down within bounds, and no-ops past the edges', () => {
    let item = createEmptyExactContent('en')
    item = addChip(item)
    item = addChip(item)
    item = addChip(item)
    const [a, b, c] = item.chips

    const movedDown = moveChip(item, a, 1)
    expect(movedDown.chips).toEqual([b, a, c])

    const movedUp = moveChip(movedDown, a, -1)
    expect(movedUp.chips).toEqual([a, b, c])

    expect(moveChip(item, a, -1)).toBe(item)
    expect(moveChip(item, c, 1)).toBe(item)
  })

  it('updates a chip label for only the targeted variant', () => {
    const withVariant = addVariant(createEmptyExactContent('en'), 'fr')
    const withChip = addChip(withVariant)
    const [chipId] = withChip.chips
    const next = updateChipLabel(withChip, 'fr', chipId, 'Comparer les offres')
    expect(next.variants.find((v) => v.locale === 'fr')?.chipLabels[chipId]).toBe('Comparer les offres')
    expect(next.variants.find((v) => v.locale === 'en')?.chipLabels[chipId]).toBe('')
  })
})

describe('validation-issue path mapping', () => {
  const issues = [
    { path: 'variants[0].body', code: 'blank_body', message: 'Body must not be blank' },
    { path: 'variants[1].locale', code: 'duplicate_locale', message: 'Locale "fr" duplicates variants[0]' },
    { path: 'variants[0].chipLabels.chip-1', code: 'chip_label_blank', message: 'Chip label must not be blank' },
    { path: 'chips', code: 'too_many_chips', message: 'At most 5 chips are allowed' },
    { path: 'variants', code: 'missing_default_variant', message: 'A variant for the agent default locale "en" is required' },
  ]

  it('finds the issue for a variant body by index', () => {
    expect(issuesForVariantBody(issues, 0)).toEqual([issues[0]])
    expect(issuesForVariantBody(issues, 1)).toEqual([])
  })

  it('finds the issue for a variant locale by index', () => {
    expect(issuesForVariantLocale(issues, 1)).toEqual([issues[1]])
  })

  it('finds an invalid_locale issue the same way, since the lookup is path-based, not code-based', () => {
    const withInvalidLocale = [
      ...issues,
      { path: 'variants[2].locale', code: 'invalid_locale', message: '"xx_YY" is not a valid locale tag' },
    ]
    expect(issuesForVariantLocale(withInvalidLocale, 2)).toEqual([withInvalidLocale[5]])
  })

  it('finds the issue for a chip label by index and chip id', () => {
    expect(issuesForChipLabel(issues, 0, 'chip-1')).toEqual([issues[2]])
    expect(issuesForChipLabel(issues, 0, 'chip-2')).toEqual([])
  })

  it('finds top-level chips and variants issues', () => {
    expect(issuesForChips(issues)).toEqual([issues[3]])
    expect(issuesForVariants(issues)).toEqual([issues[4]])
  })
})

describe('applyEditedItem', () => {
  it('pairs the edited item with a cleared issues array, so a caller applying it drops every stale diagnostic, not just the fixed field', () => {
    const edited: ExactContentItem = { chips: [], variants: [{ locale: 'en', body: 'Hi there', chipLabels: {} }] }

    const result = applyEditedItem(edited)

    expect(result.item).toBe(edited)
    expect(result.issues).toEqual([])
  })
})

describe('extractValidationIssuesFromError', () => {
  it('reads issues off an ApiError-shaped 400 body', () => {
    const issues = [{ path: 'variants[0].body', code: 'blank_body', message: 'Body must not be blank' }]
    const error = { status: 400, error: { code: 'bad_request', message: 'Exact greeting content is invalid', details: { issues } } }
    expect(extractValidationIssuesFromError(error)).toEqual(issues)
  })

  it('returns null for an unrelated error shape', () => {
    expect(extractValidationIssuesFromError(new Error('network down'))).toBeNull()
    expect(extractValidationIssuesFromError({ status: 500, error: { code: 'internal', message: 'oops' } })).toBeNull()
    expect(extractValidationIssuesFromError(null)).toBeNull()
  })
})
