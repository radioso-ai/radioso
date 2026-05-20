const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B'
  }
  const exponent = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const scaled = value / Math.pow(1024, exponent)
  const formatted = exponent === 0 ? scaled.toFixed(0) : scaled.toFixed(scaled >= 10 ? 0 : 1)
  return `${formatted} ${BYTE_UNITS[exponent]}`
}
