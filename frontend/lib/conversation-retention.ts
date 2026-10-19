/** The range the API accepts for a conversation retention window, in whole days. */
export const CONVERSATION_RETENTION_DAYS_MIN = 7
export const CONVERSATION_RETENTION_DAYS_MAX = 3650

/** The windows the settings card offers by name; any other value shows as a custom number of days. */
export const conversationRetentionPresets = [
  { value: 'off', label: 'Keep until deleted', days: null },
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: '180', label: '180 days', days: 180 },
  { value: '365', label: '1 year', days: 365 },
  { value: '730', label: '2 years', days: 730 },
] as const

/** The select's value for a stored window: a preset's, or `custom` for any other number of days. */
export const retentionChoiceFor = (days: number | null): string =>
  conversationRetentionPresets.find((preset) => preset.days === days)?.value ?? 'custom'

/** A custom window typed as text, or null when it is not whole days inside the accepted range. */
export const parseCustomRetentionDays = (text: string): number | null => {
  if (!/^\d+$/.test(text.trim())) return null
  const days = Number(text.trim())
  return days >= CONVERSATION_RETENTION_DAYS_MIN && days <= CONVERSATION_RETENTION_DAYS_MAX ? days : null
}

/**
 * Whether saving `next` over `current` lets the sweep erase conversations it would have kept: a
 * window where there was none, or a shorter one. Only that save asks the operator to confirm.
 */
export const retentionErasesSooner = (current: number | null, next: number | null): boolean =>
  next !== null && (current === null || next < current)
