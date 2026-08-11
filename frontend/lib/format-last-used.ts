const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
]

/** Renders a channel's last-used timestamp as coarse relative time for settings cards. */
export const formatLastUsed = (value: string | null | undefined) => {
  if (!value) {
    return 'Never used'
  }
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) {
    return 'Last used: Unknown'
  }
  const diffSeconds = Math.round((timestamp - Date.now()) / 1000)
  const absoluteSeconds = Math.abs(diffSeconds)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, unitSeconds] of UNITS) {
    if (absoluteSeconds >= unitSeconds) {
      return `Last used: ${formatter.format(Math.round(diffSeconds / unitSeconds), unit)}`
    }
  }
  return `Last used: ${formatter.format(diffSeconds, 'second')}`
}
