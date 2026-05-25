'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
}: FilterDialogProps) {
  const [draft, setDraft] = useState<FilterValues>(values)

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto py-2 pr-1">
          {filters.map((filter) => (
            <FilterRow
              key={filter.id}
              filter={filter}
              value={draft[filter.id]}
              onChange={(next) => setDraft((current) => ({ ...current, [filter.id]: next }))}
            />
          ))}
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

interface FilterRowProps {
  filter: FilterDefinition
  value: FilterValue | undefined
  onChange: (next: FilterValue | undefined) => void
}

function FilterRow({ filter, value, onChange }: FilterRowProps) {
  switch (filter.kind) {
    case 'multi-select':
      return (
        <MultiSelectRow
          label={filter.label}
          options={filter.options}
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
  options,
  selected,
  onChange,
}: {
  label: string
  options: ReadonlyArray<FilterOption>
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value])
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">{label}</p>
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
  placeholder,
  options,
  selected,
  onChange,
}: {
  label: string
  placeholder?: string
  options: ReadonlyArray<FilterOption>
  selected: string | null
  onChange: (next: string | null) => void
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-foreground">{label}</p>
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
