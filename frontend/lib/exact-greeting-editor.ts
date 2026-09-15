import { createClientId } from './client-id'
import type { AgentGreetingValidationIssue, ExactContentItem } from './api-types'

/**
 * Pure editor-state transitions and validation-issue lookups for the exact-greeting
 * authoring UI (spec 1150 US1/US3/US4, FR-005/FR-007/FR-008). `ExactContentItem` is the
 * wire shape the backend already validates and persists — the editor uses it directly as
 * its state so authoring, save, and preview never carry a second, duplicated shape.
 *
 * Knows nothing of React, HTTP, or the dashboard; the component layer owns rendering and
 * calling `agentGreetingApi.saveDraft`.
 */

export const EXACT_GREETING_MAX_CHIPS = 5
export const EXACT_GREETING_BODY_MAX_CODE_POINTS = 8000
export const EXACT_GREETING_CHIP_LABEL_MAX_CODE_POINTS = 80

/** Unicode code points, not UTF-16 units, matching the backend counter (FR-009) so a
 * remaining-characters display never disagrees with what publish will accept. */
export const codePointLength = (value: string): number => [...value].length

export const createEmptyExactContent = (defaultLocale: string): ExactContentItem => ({
  chips: [],
  variants: [{ locale: defaultLocale, body: '', chipLabels: {} }],
})

const sameLocale = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

export const hasVariantForLocale = (item: ExactContentItem, locale: string): boolean =>
  item.variants.some((variant) => sameLocale(variant.locale, locale))

/** No-ops on a blank or already-present locale; the caller (combobox) also prevents this, but the editor never depends on the caller for correctness. */
export const addVariant = (item: ExactContentItem, locale: string): ExactContentItem => {
  const trimmed = locale.trim()
  if (!trimmed || hasVariantForLocale(item, trimmed)) {
    return item
  }
  const chipLabels = Object.fromEntries(item.chips.map((chipId) => [chipId, '']))
  return { ...item, variants: [...item.variants, { locale: trimmed, body: '', chipLabels }] }
}

export const removeVariant = (item: ExactContentItem, locale: string): ExactContentItem => ({
  ...item,
  variants: item.variants.filter((variant) => !sameLocale(variant.locale, locale)),
})

export const updateVariantBody = (item: ExactContentItem, locale: string, body: string): ExactContentItem => ({
  ...item,
  variants: item.variants.map((variant) => (sameLocale(variant.locale, locale) ? { ...variant, body } : variant)),
})

const createChipId = (): string => createClientId('chip')

/** No-ops once at the FR-008 limit; the caller disables the "add chip" control at the same bound. */
export const addChip = (item: ExactContentItem): ExactContentItem => {
  if (item.chips.length >= EXACT_GREETING_MAX_CHIPS) {
    return item
  }
  const chipId = createChipId()
  return {
    chips: [...item.chips, chipId],
    variants: item.variants.map((variant) => ({
      ...variant,
      chipLabels: { ...variant.chipLabels, [chipId]: '' },
    })),
  }
}

export const removeChip = (item: ExactContentItem, chipId: string): ExactContentItem => ({
  chips: item.chips.filter((id) => id !== chipId),
  variants: item.variants.map((variant) => {
    const nextLabels = { ...variant.chipLabels }
    delete nextLabels[chipId]
    return { ...variant, chipLabels: nextLabels }
  }),
})

export const moveChip = (item: ExactContentItem, chipId: string, direction: -1 | 1): ExactContentItem => {
  const index = item.chips.indexOf(chipId)
  const destination = index + direction
  if (index < 0 || destination < 0 || destination >= item.chips.length) {
    return item
  }
  const chips = [...item.chips]
  ;[chips[index], chips[destination]] = [chips[destination], chips[index]]
  return { ...item, chips }
}

export const updateChipLabel = (
  item: ExactContentItem,
  locale: string,
  chipId: string,
  label: string,
): ExactContentItem => ({
  ...item,
  variants: item.variants.map((variant) =>
    sameLocale(variant.locale, locale)
      ? { ...variant, chipLabels: { ...variant.chipLabels, [chipId]: label } }
      : variant,
  ),
})

// --- Validation-issue -> field lookup (FR-007). Path format is owned by
// `backend/src/shared/domain/exactContent.ts#validateExactContentItem`; these helpers are
// the one place the frontend knows that format, so a path-string change only touches here. ---

export type ExactGreetingIssue = AgentGreetingValidationIssue

const variantBodyPath = (index: number): string => `variants[${index}].body`
const variantLocalePath = (index: number): string => `variants[${index}].locale`
const chipLabelPath = (index: number, chipId: string): string => `variants[${index}].chipLabels.${chipId}`

const issuesForPath = (
  issues: readonly ExactGreetingIssue[],
  path: string,
): ExactGreetingIssue[] => issues.filter((issue) => issue.path === path)

export const issuesForVariantBody = (
  issues: readonly ExactGreetingIssue[],
  index: number,
): ExactGreetingIssue[] => issuesForPath(issues, variantBodyPath(index))

export const issuesForVariantLocale = (
  issues: readonly ExactGreetingIssue[],
  index: number,
): ExactGreetingIssue[] => issuesForPath(issues, variantLocalePath(index))

export const issuesForChipLabel = (
  issues: readonly ExactGreetingIssue[],
  index: number,
  chipId: string,
): ExactGreetingIssue[] => issuesForPath(issues, chipLabelPath(index, chipId))

export const issuesForChips = (issues: readonly ExactGreetingIssue[]): ExactGreetingIssue[] =>
  issuesForPath(issues, 'chips')

export const issuesForVariants = (issues: readonly ExactGreetingIssue[]): ExactGreetingIssue[] =>
  issuesForPath(issues, 'variants')

/**
 * `PUT .../greeting/draft` returns 200 with `validation.issues` unless Exact words is
 * enabled and content is invalid, in which case it's a 400 `ApiError` whose
 * `error.details` carries the same `{ issues }` shape (`badRequest("...", { issues })` in
 * `agentService.ts`). Callers use this so both response shapes feed the same field-level
 * display.
 */
export const extractValidationIssuesFromError = (error: unknown): ExactGreetingIssue[] | null => {
  if (!error || typeof error !== 'object' || !('error' in error)) {
    return null
  }
  const body = (error as { error?: unknown }).error
  if (!body || typeof body !== 'object' || !('details' in body)) {
    return null
  }
  const details = (body as { details?: unknown }).details
  if (!details || typeof details !== 'object' || !('issues' in details)) {
    return null
  }
  const issues = (details as { issues?: unknown }).issues
  return Array.isArray(issues) ? (issues as ExactGreetingIssue[]) : null
}
