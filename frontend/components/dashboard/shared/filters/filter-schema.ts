/**
 * Schema-driven filter system shared across dashboard surfaces.
 *
 * Each surface declares an array of `FilterDefinition` items. The `FilterDialog`
 * renders the appropriate picker per kind; `ActiveFilterPills` renders applied
 * filters as removable chips. Values are passed in and out as `FilterValues`
 * (an `id`-keyed record) — the surface owns URL persistence.
 *
 * Adding a new kind requires four touch-points: a branch in `FilterValue`, a
 * branch in `FilterDefinition`, a renderer in `FilterDialog`, and a pill formatter
 * in `ActiveFilterPills`. Adding a new filter to an existing surface is one entry
 * in that surface's schema array.
 */

export type FilterValue =
  | { kind: 'multi-select'; values: string[] }
  | { kind: 'single-select'; value: string }
  | { kind: 'boolean'; value: true }

export type FilterValues = Record<string, FilterValue | undefined>

export interface FilterOption {
  value: string
  label: string
  description?: string
}

export type FilterDefinition =
  | {
      id: string
      kind: 'multi-select'
      label: string
      options: ReadonlyArray<FilterOption>
      presentation?: 'list' | 'pills'
    }
  | {
      id: string
      kind: 'single-select'
      label: string
      placeholder?: string
      options: ReadonlyArray<FilterOption>
    }
  | {
      id: string
      kind: 'boolean'
      label: string
    }

/**
 * Optional presentation grouping for the dialog. A section gathers one or more
 * filters (by id) under a collapsible heading. Filters not referenced by any
 * section render flat. Sections are layout-only — values stay keyed by filter
 * `id`, so URL persistence is unaffected.
 */
export interface FilterSection {
  id: string
  label: string
  defaultOpen?: boolean
  filterIds: ReadonlyArray<string>
}

export const countAppliedFilters = (values: FilterValues): number => {
  let count = 0
  for (const value of Object.values(values)) {
    if (!value) continue
    if (value.kind === 'multi-select' && value.values.length === 0) continue
    count += 1
  }
  return count
}

export const isFilterApplied = (value: FilterValue | undefined): boolean => {
  if (!value) return false
  if (value.kind === 'multi-select') return value.values.length > 0
  return true
}
