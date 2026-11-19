const dayMonthFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const dayMonthTimeFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

const formatWith = (format: Intl.DateTimeFormat, iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : format.format(date)
}

/** "12 Nov" in the reader's locale. */
export const formatDayMonth = (iso: string): string => formatWith(dayMonthFormat, iso)

/** "19 Nov, 06:00" in the reader's locale. */
export const formatDayMonthTime = (iso: string): string => formatWith(dayMonthTimeFormat, iso)

/** "Nov 12, 2026" in the reader's locale. */
export const formatDay = (iso: string): string => formatWith(dayFormat, iso)

export const formatPeriod = (period: { start: string; end: string }): string =>
  `${formatDayMonth(period.start)} – ${formatDayMonth(period.end)}`
