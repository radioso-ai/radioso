/** The select value standing for "no zone set": the workspace reads today in UTC. */
export const DEFAULT_TIME_ZONE_OPTION = 'default'

interface TimeZoneOption {
  value: string
  label: string
}

/** The IANA zones this browser knows; empty where the runtime cannot list them. */
export const supportedTimeZones = (): readonly string[] => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return []
  }
}

/** The name this browser resolves `zone` to, or null for a zone it does not know. */
const browserZoneName = (zone: string): string | null => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/**
 * The time zone select's options: UTC as the default, then every known zone, sorted. A stored
 * zone the browser does not list (another name for a listed zone, or a zone newer than its data)
 * is kept, so the select shows what is saved. Where the browser lists the same zone by another
 * name (Chrome lists `Asia/Calcutta` for a saved `Asia/Kolkata`), the saved name takes its place,
 * so the zone appears once.
 */
export const timeZoneOptions = (supported: readonly string[], stored: string | null): TimeZoneOption[] => {
  const zones = new Set(supported)
  if (stored) {
    const listedName = browserZoneName(stored)
    if (listedName && listedName !== stored) zones.delete(listedName)
    zones.add(stored)
  }
  return [
    { value: DEFAULT_TIME_ZONE_OPTION, label: 'UTC (default)' },
    ...[...zones].sort().map((zone) => ({ value: zone, label: zone })),
  ]
}

export const timeZoneOptionFor = (timeZone: string | null): string => timeZone ?? DEFAULT_TIME_ZONE_OPTION

export const timeZoneFromOption = (option: string): string | null =>
  option === DEFAULT_TIME_ZONE_OPTION ? null : option
