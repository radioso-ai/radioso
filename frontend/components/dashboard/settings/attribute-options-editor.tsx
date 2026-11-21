'use client'

import { Archive, ArchiveRestore, Plus, Trash2 } from 'lucide-react'

import { SettingFieldHeader } from '@/components/dashboard/settings/settings-flow'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ContextVariableOption } from '@/lib/api'
import { cn } from '@/lib/utils'

const OPTION_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_OPTIONS = 50

/** The first problem with an enum attribute's options, or null when they can be saved. */
export const attributeOptionsError = (options: readonly ContextVariableOption[]): string | null => {
  if (options.length === 0) return 'Add at least one option.'
  if (options.length > MAX_OPTIONS) return `Use at most ${MAX_OPTIONS} options.`
  const keys = new Set<string>()
  for (const option of options) {
    if (!option.label.trim()) return 'Every option needs a label.'
    if (!OPTION_KEY_PATTERN.test(option.key)) return 'Keys use letters, numbers and underscores, and start with a letter.'
    if (keys.has(option.key)) return `Key "${option.key}" is used twice.`
    keys.add(option.key)
  }
  return null
}

/**
 * The options of an enum attribute. A saved option keeps its key and is archived rather than
 * removed, because stored values and filters name it by key; an option added in this edit can
 * still be removed. The saved options are the first `savedCount` rows: the edit starts from them,
 * appends new rows after them and removes only new rows, so a row's position says which it is
 * whatever key a new row is given.
 */
export function AttributeOptionsEditor({
  options,
  savedCount,
  onChange,
}: {
  options: ContextVariableOption[]
  savedCount: number
  onChange: (options: ContextVariableOption[]) => void
}) {
  const update = (index: number, patch: Partial<ContextVariableOption>) =>
    onChange(options.map((option, position) => (position === index ? { ...option, ...patch } : option)))

  return (
    <div className="space-y-3">
      <SettingFieldHeader label="Options" description="What a value can be. Archive an option to retire it." />
      {options.map((option, index) => {
        const saved = index < savedCount
        const name = option.label.trim() || option.key || `option ${index + 1}`
        return (
          <div
            key={index}
            className={cn('grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto]', option.archived && 'opacity-60')}
          >
            <Input
              aria-label={`Option ${index + 1} label`}
              value={option.label}
              onChange={(event) => update(index, { label: event.target.value })}
              maxLength={120}
              placeholder="Billing"
            />
            <Input
              aria-label={`Option ${index + 1} key`}
              value={option.key}
              onChange={(event) => update(index, { key: event.target.value })}
              disabled={saved}
              maxLength={120}
              placeholder="billing"
              className="font-mono"
            />
            <Input
              aria-label={`Option ${index + 1} description`}
              value={option.description ?? ''}
              onChange={(event) => update(index, { description: event.target.value || null })}
              maxLength={300}
              placeholder="When it applies"
            />
            {saved ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => update(index, { archived: !option.archived })}
                aria-label={`${option.archived ? 'Restore' : 'Archive'} ${name}`}
              >
                {option.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange(options.filter((_, position) => position !== index))}
                aria-label={`Remove ${name}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...options, { key: '', label: '', description: null, archived: false }])}
        disabled={options.length >= MAX_OPTIONS}
      >
        <Plus className="mr-2 h-4 w-4" />
        Add option
      </Button>
    </div>
  )
}
