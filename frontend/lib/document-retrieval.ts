// Pure helpers for presenting a document's retrieval eligibility. The backend
// owns the authoritative filter; these derive the display state and convert
// between a stored ISO expiry instant and the `<input type="date">` value.

export type DocumentRetrievalState = 'included' | 'excluded' | 'expired' | 'scheduled'

export interface DocumentRetrievalFields {
  retrievalEnabled: boolean
  retrievalExpiresAt: string | null
}

/**
 * Derives how a document should read in the UI:
 * - `excluded`  — retrieval is turned off for the document.
 * - `expired`   — its auto-exclude date has passed (while still enabled).
 * - `scheduled` — enabled now, but will be auto-excluded on a future date.
 * - `included`  — retrievable with no expiry.
 */
export function getDocumentRetrievalState(
  document: DocumentRetrievalFields,
  now: Date = new Date(),
): DocumentRetrievalState {
  if (!document.retrievalEnabled) {
    return 'excluded'
  }
  if (document.retrievalExpiresAt) {
    const expiresAt = new Date(document.retrievalExpiresAt)
    if (!Number.isNaN(expiresAt.getTime())) {
      return expiresAt.getTime() <= now.getTime() ? 'expired' : 'scheduled'
    }
  }
  return 'included'
}

/** True when the document is a retrieval candidate right now. */
export function isRetrievable(document: DocumentRetrievalFields, now: Date = new Date()): boolean {
  const state = getDocumentRetrievalState(document, now)
  return state === 'included' || state === 'scheduled'
}

/** Formats a stored ISO expiry as the local `YYYY-MM-DD` an `<input type="date">` expects. */
export function toDateInputValue(iso: string | null): string {
  if (!iso) {
    return ''
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Converts a `YYYY-MM-DD` date-input value to the ISO instant stored as the
 * expiry. The document stays retrievable through the whole selected day and is
 * excluded once it passes, so we anchor to the end of that day in local time.
 * Returns null for an empty/invalid value (clears the expiry).
 */
export function endOfDayIsoFromDateInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) {
    return null
  }
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toISOString()
}

/** Today as a local `YYYY-MM-DD`, used as the date picker's `min`. */
export function todayDateInputValue(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
