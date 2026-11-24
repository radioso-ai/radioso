import type { ReactNode } from 'react'

type OptionLike = { key: string; label: string; description?: string | null; archived?: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOptionList = (value: unknown): value is OptionLike[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => isRecord(item) && typeof item.key === 'string' && typeof item.label === 'string')

const formatScalar = (value: unknown): string => {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable value]'
  }
}

/** A proposal diff cell: a Choice attribute's options read as one line each, anything else as text. */
export function ProposalValue({ value }: { value: unknown }): ReactNode {
  if (!isOptionList(value)) return formatScalar(value)
  return (
    <ul className="space-y-1">
      {value.map((option) => (
        <li key={option.key}>
          <span className="font-medium">{option.label}</span> <span className="text-muted-foreground">({option.key})</span>
          {option.archived ? <span className="text-muted-foreground"> · archived</span> : null}
          {option.description ? <span className="text-muted-foreground"> — {option.description}</span> : null}
        </li>
      ))}
    </ul>
  )
}
