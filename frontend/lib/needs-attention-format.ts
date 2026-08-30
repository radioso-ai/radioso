const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const absoluteRowTimestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Relative-time label for a feedback item's timestamp (e.g. "2 hours ago"). */
export const formatApprovalCreatedAt = (createdAt: string, now = new Date()): string => {
  const created = new Date(createdAt)
  if (Number.isNaN(created.getTime())) {
    return createdAt
  }

  const diffSeconds = Math.round((created.getTime() - now.getTime()) / 1000)
  const absSeconds = Math.abs(diffSeconds)
  if (absSeconds < 60) {
    return relativeTimeFormatter.format(diffSeconds, 'second')
  }

  const diffMinutes = Math.round(diffSeconds / 60)
  const absMinutes = Math.abs(diffMinutes)
  if (absMinutes < 60) {
    return relativeTimeFormatter.format(diffMinutes, 'minute')
  }

  const diffHours = Math.round(diffMinutes / 60)
  const absHours = Math.abs(diffHours)
  if (absHours < 24) {
    return relativeTimeFormatter.format(diffHours, 'hour')
  }

  return relativeTimeFormatter.format(Math.round(diffHours / 24), 'day')
}

/**
 * Absolute day + time label (e.g. "26 Aug, 4:40 PM") shared by every inbox
 * surface that shows "when" rather than "how long ago" — the All lens's
 * conversation rows (all-conversations-list-pane.tsx) and the Needs-you
 * lens's recently-closed strip (inbox-queue-row.tsx). Kept in one place so
 * the two surfaces never drift into two different date formats.
 */
export const formatInboxRowTimestamp = (value: string): string => absoluteRowTimestampFormatter.format(new Date(value))
