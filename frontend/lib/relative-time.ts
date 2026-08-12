export const relativeTimestamp = (value: string) => {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value

  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const absolute = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'minute'],
    [60, 'hour'],
    [24, 'day'],
    [7, 'week'],
    [4, 'month'],
    [12, 'year'],
  ]
  let amount = seconds
  let unit: Intl.RelativeTimeFormatUnit = 'second'
  for (const [threshold, nextUnit] of units) {
    if (Math.abs(amount) < threshold) break
    amount = Math.round(amount / threshold)
    unit = nextUnit
  }
  return absolute.format(amount, unit)
}
