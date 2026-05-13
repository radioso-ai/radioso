'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'

import { Input } from '@/components/ui/input'
import {
  ASSISTANT_GREETING_LOCALE_OPTIONS,
  NO_GREETING_LOCALE_LABEL,
} from '@/components/dashboard/settings/assistant-locale-options'

interface LocaleOption {
  label: string
  hint: string
}

const BASE_OPTIONS: LocaleOption[] = [
  { label: NO_GREETING_LOCALE_LABEL, hint: 'No automatic first greeting' },
  ...ASSISTANT_GREETING_LOCALE_OPTIONS.map((option) => ({ label: option.label, hint: option.tag })),
]

export function AssistantLocaleCombobox({
  id,
  value,
  onChange,
  placeholder = 'Search for a language or type a locale tag',
}: {
  id?: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const filtered = useMemo(() => {
    const query = value.trim().toLowerCase()
    if (!query) return BASE_OPTIONS
    const isExactSelection = BASE_OPTIONS.some(
      (option) => option.label.toLowerCase() === query || option.hint.toLowerCase() === query,
    )
    if (isExactSelection) return BASE_OPTIONS
    return BASE_OPTIONS.filter(
      (option) =>
        option.label.toLowerCase().includes(query) ||
        option.hint.toLowerCase().includes(query),
    )
  }, [value])

  const handleSelect = (label: string) => {
    onChange(label)
    setOpen(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Input
          id={id}
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={id ? `${id}-listbox` : undefined}
          className="pr-9"
        />
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(event) => {
            event.preventDefault()
            setOpen((current) => !current)
          }}
          className="absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground hover:text-foreground"
          aria-label="Toggle language list"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && filtered.length > 0 ? (
        <ul
          id={id ? `${id}-listbox` : undefined}
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm shadow-md"
        >
          {filtered.map((option) => (
            <li key={option.label} role="option" aria-selected={option.label === value}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault()
                  handleSelect(option.label)
                }}
                className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-accent hover:text-accent-foreground ${
                  option.label === value ? 'bg-accent/40' : ''
                }`}
              >
                <span>{option.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{option.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
