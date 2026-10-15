'use client'

import { useState, type ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import { AssistantLocaleCombobox } from '@/components/dashboard/settings/assistant-locale-combobox'
import { getAssistantLocaleLabel, resolveAssistantLocaleInput } from '@/components/dashboard/settings/assistant-locale-options'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Pieces for settings keyed by language tag: an "Add a language" field, one bordered group per
 * language, and a list of single-line entries inside it. They hold no settings shape of their own;
 * the card that uses them owns the value and how it is saved.
 */

export function AddLanguageField({
  id,
  existingLocales,
  disabled = false,
  onAdd,
}: {
  id: string
  existingLocales: readonly string[]
  disabled?: boolean
  onAdd: (locale: string) => void
}) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = () => {
    const resolved = resolveAssistantLocaleInput(input)
    if (!resolved) {
      setError(resolved === undefined ? 'Not a recognized language or locale tag.' : 'Choose a language.')
      return
    }
    if (existingLocales.some((locale) => locale.toLowerCase() === resolved.toLowerCase())) {
      setError('That language is already added.')
      return
    }
    onAdd(resolved)
    setInput('')
    setError(null)
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-foreground">Add a language</Label>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <AssistantLocaleCombobox id={id} value={input} onChange={setInput} placeholder="Language or tag, e.g. it or pt-BR" noFallbackOptionEnabled={false} />
        </div>
        <Button type="button" size="sm" variant="outline" onClick={add} disabled={disabled || !input.trim()}>
          Add
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

export function LanguageGroup({ locale, label, onRemove, children }: { locale: string; label: string; onRemove: () => void; children: ReactNode }) {
  const languageLabel = getAssistantLocaleLabel(locale)
  return (
    <div role="group" aria-label={`${label}: ${languageLabel}`} className="space-y-4 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline">{languageLabel}</Badge>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          Remove language
        </Button>
      </div>
      {children}
    </div>
  )
}

export function LineListEditor({
  label,
  lines,
  maxLines,
  maxLength,
  placeholder,
  onChange,
}: {
  label: string
  lines: readonly string[]
  maxLines: number
  maxLength: number
  placeholder?: string
  onChange: (next: string[]) => void
}) {
  const replace = (index: number, value: string) => onChange(lines.map((line, at) => (at === index ? value : line)))
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-foreground">{label}</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`Add ${label.toLowerCase()} line`}
          disabled={lines.length >= maxLines}
          onClick={() => onChange([...lines, ''])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add line
        </Button>
      </div>
      {lines.map((line, index) => (
        // A line has no identity beyond its position; the inputs are controlled, so removal re-renders cleanly.
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`${label} line ${index + 1}`}
            value={line}
            maxLength={maxLength}
            placeholder={placeholder}
            onChange={(event) => replace(index, event.target.value)}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Remove ${label.toLowerCase()} line ${index + 1}`}
            onClick={() => onChange(lines.filter((_, at) => at !== index))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  )
}
