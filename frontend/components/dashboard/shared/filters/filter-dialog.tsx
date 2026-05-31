'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  isFilterApplied,
  type FilterDefinition,
  type FilterOption,
  type FilterSection,
  type FilterValue,
  type FilterValues,
} from './filter-schema'

const UNSET_SINGLE_SELECT_VALUE = '__unset__'

interface FilterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  filters: ReadonlyArray<FilterDefinition>
  values: FilterValues
  onApply: (next: FilterValues) => void
  title?: string
  description?: string
  /** Optional collapsible grouping. Filters not referenced render flat below. */
  sections?: ReadonlyArray<FilterSection>
}

const normalizeValues = (values: FilterValues): string => {
  const entries = Object.entries(values)
    .flatMap(([id, value]) => {
      if (!value || !isFilterApplied(value)) {
        return []
      }
      if (value.kind === 'multi-select') {
        return [[id, value.kind, [...value.values].sort().join(',')]]
      }
      if (value.kind === 'single-select') {
        return [[id, value.kind, value.value]]
      }
      return [[id, value.kind, 'true']]
    })
    .sort(([left], [right]) => left.localeCompare(right))

  return JSON.stringify(entries)
}

export function FilterDialog({
  open,
  onOpenChange,
  filters,
  values,
  onApply,
  title = 'Filter',
  description,
  sections,
}: FilterDialogProps) {
  const [draft, setDraft] = useState<FilterValues>(values)
  const filterById = useMemo(() => new Map(filters.map((filter) => [filter.id, filter])), [filters])

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset draft to current values each time the dialog opens.
      setDraft(values)
    }
  }, [open, values])

  const handleApply = () => {
    onApply(draft)
    onOpenChange(false)
  }

  const handleClear = () => {
    setDraft({})
  }

  const hasAnyDraftApplied = useMemo(
    () => Object.values(draft).some(isFilterApplied),
    [draft],
  )
  const hasDraftChanged = useMemo(
    () => normalizeValues(draft) !== normalizeValues(values),
    [draft, values],
  )

  const renderFilterRow = (filter: FilterDefinition, hideLabel: boolean) => (
    <FilterRow
      key={filter.id}
      filter={filter}
      value={draft[filter.id]}
      hideLabel={hideLabel}
      onChange={(next) => setDraft((current) => ({ ...current, [filter.id]: next }))}
    />
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <div
          className={cn(
            'max-h-[60vh] overflow-y-auto py-2 pr-1',
            sections && sections.length > 0 ? 'space-y-3' : 'space-y-5',
          )}
        >
          {sections && sections.length > 0 ? (
            <>
              {sections.map((section) => {
                const sectionFilters = section.filterIds
                  .map((id) => filterById.get(id))
                  .filter((filter): filter is FilterDefinition => Boolean(filter))
                if (sectionFilters.length === 0) {
                  return null
                }
                const appliedCount = sectionFilters.filter((filter) =>
                  isFilterApplied(draft[filter.id]),
                ).length
                // Open if asked to, or if it already carries an applied filter so
                // active filters are never hidden behind a collapsed header.
                const initiallyOpen =
                  Boolean(section.defaultOpen) ||
                  sectionFilters.some((filter) => isFilterApplied(values[filter.id]))
                const hideInnerLabels = sectionFilters.length === 1
                return (
                  <FilterSectionCard
                    key={section.id}
                    label={section.label}
                    appliedCount={appliedCount}
                    defaultOpen={initiallyOpen}
                  >
                    {sectionFilters.map((filter) => renderFilterRow(filter, hideInnerLabels))}
                  </FilterSectionCard>
                )
              })}
              {filters
                .filter((filter) => !sections.some((section) => section.filterIds.includes(filter.id)))
                .map((filter) => renderFilterRow(filter, false))}
            </>
          ) : (
            filters.map((filter) => renderFilterRow(filter, false))
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={handleClear}
            disabled={!hasAnyDraftApplied}
            className="mr-auto"
          >
            Clear all
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleApply} disabled={!hasDraftChanged}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FilterSectionCard({
  label,
  appliedCount,
  defaultOpen,
  children,
}: {
  label: string
  appliedCount: number
  defaultOpen: boolean
  children: ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-lg border border-border">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex items-center gap-2">
          {label}
          {appliedCount > 0 ? (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
              {appliedCount}
            </span>
          ) : null}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 border-t border-border px-3 pb-3 pt-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

interface FilterRowProps {
  filter: FilterDefinition
  value: FilterValue | undefined
  onChange: (next: FilterValue | undefined) => void
  hideLabel?: boolean
}

function FilterRow({ filter, value, onChange, hideLabel = false }: FilterRowProps) {
  switch (filter.kind) {
    case 'multi-select':
      return (
        <MultiSelectRow
          label={filter.label}
          hideLabel={hideLabel}
          options={filter.options}
          presentation={filter.presentation ?? 'list'}
          selected={value?.kind === 'multi-select' ? value.values : []}
          onChange={(next) =>
            onChange(next.length === 0 ? undefined : { kind: 'multi-select', values: next })
          }
        />
      )
    case 'single-select':
      return (
        <SingleSelectRow
          label={filter.label}
          hideLabel={hideLabel}
          placeholder={filter.placeholder}
          options={filter.options}
          selected={value?.kind === 'single-select' ? value.value : null}
          onChange={(next) =>
            onChange(next === null ? undefined : { kind: 'single-select', value: next })
          }
        />
      )
    case 'boolean':
      return (
        <BooleanRow
          label={filter.label}
          checked={value?.kind === 'boolean' ? value.value : false}
          onChange={(next) => onChange(next ? { kind: 'boolean', value: true } : undefined)}
        />
      )
  }
}

function MultiSelectRow({
  label,
  hideLabel = false,
  options,
  presentation,
  selected,
  onChange,
}: {
  label: string
  hideLabel?: boolean
  options: ReadonlyArray<FilterOption>
  presentation: 'list' | 'pills'
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value])
  }

  if (presentation === 'pills') {
    return (
      <div className="space-y-2">
        {hideLabel ? null : <p className="text-sm font-medium text-foreground">{label}</p>}
        <div className="flex flex-wrap gap-1.5">
          {options.map((option) => {
            const checked = selected.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => toggle(option.value)}
                title={option.description}
                aria-pressed={checked}
                className={cn(
                  'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                  checked
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background text-foreground hover:bg-accent/40',
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {hideLabel ? null : <p className="text-sm font-medium text-foreground">{label}</p>}
      <div className="space-y-1">
        {options.map((option) => {
          const checked = selected.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(option.value)}
              className={cn(
                'flex w-full items-start gap-3 rounded-md border border-transparent px-2 py-1.5 text-left transition',
                'hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                checked && 'bg-accent/60',
              )}
              aria-pressed={checked}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                  checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background',
                )}
                aria-hidden
              >
                {checked ? <Check className="h-3 w-3" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-foreground">{option.label}</span>
                {option.description ? (
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SingleSelectRow({
  label,
  hideLabel = false,
  placeholder,
  options,
  selected,
  onChange,
}: {
  label: string
  hideLabel?: boolean
  placeholder?: string
  options: ReadonlyArray<FilterOption>
  selected: string | null
  onChange: (next: string | null) => void
}) {
  return (
    <div className="space-y-1.5">
      {hideLabel ? null : <p className="text-sm font-medium text-foreground">{label}</p>}
      <Select
        value={selected ?? UNSET_SINGLE_SELECT_VALUE}
        onValueChange={(next) => onChange(next === UNSET_SINGLE_SELECT_VALUE ? null : next)}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder ?? 'Any'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET_SINGLE_SELECT_VALUE}>{placeholder ?? 'Any'}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function BooleanRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md px-1 py-1.5">
      <span className="text-sm text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
