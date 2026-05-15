'use client'

import { cn } from '@/lib/utils'

export type ExampleLanguage = 'curl' | 'typescript'

const LANGUAGE_LABELS: Record<ExampleLanguage, string> = {
  curl: 'curl',
  typescript: 'TypeScript',
}

export function ExampleSelector({
  value,
  onChange,
}: {
  value: ExampleLanguage
  onChange: (value: ExampleLanguage) => void
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5" role="group">
      {(['curl', 'typescript'] as const).map((language) => {
        const isActive = value === language
        return (
          <button
            key={language}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(language)}
            className={cn(
              'rounded-sm px-3 py-1 text-xs font-medium transition-colors',
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {LANGUAGE_LABELS[language]}
          </button>
        )
      })}
    </div>
  )
}
