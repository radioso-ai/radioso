import type { ApiValueType } from '@/lib/api-connections'

// Structural format rules mirroring the backend's input coercion (skillDataContract/values.ts).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/u
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u
const ISO_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/iu

const isCalendarDate = (value: string): boolean => {
  const match = ISO_DATE_PATTERN.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

const dateOf = (value: string): string | null => {
  if (isCalendarDate(value)) return value
  const match = ISO_DATE_TIME_PATTERN.exec(value)
  if (!match || !isCalendarDate(match[1])) return null
  return Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59 ? null : match[1]
}

/**
 * A sample typed into the test panel in the form the real skill sends for its declared type. A
 * sample that does not convert is sent as typed, so the backend's `invalid_input` shows.
 */
export const coerceApiTestSample = (type: ApiValueType, text: string): string | number | boolean => {
  const trimmed = text.trim()
  switch (type) {
    case 'text':
      return trimmed
    case 'email':
      return EMAIL_PATTERN.test(trimmed) ? trimmed : text
    case 'number': {
      const number = DECIMAL_PATTERN.test(trimmed) ? Number(trimmed) : Number.NaN
      return Number.isFinite(number) ? number : text
    }
    case 'boolean': {
      const lowered = trimmed.toLowerCase()
      return lowered === 'true' || lowered === 'false' ? lowered === 'true' : text
    }
    case 'date':
      return dateOf(trimmed) ?? text
  }
}
