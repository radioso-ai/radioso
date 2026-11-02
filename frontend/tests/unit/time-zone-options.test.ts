import { describe, expect, it } from 'vitest'

import { DEFAULT_TIME_ZONE_OPTION, timeZoneFromOption, timeZoneOptionFor, timeZoneOptions } from '@/lib/time-zone-options'

describe('time zone options', () => {
  it('offers UTC as the default first, then every zone the browser knows', () => {
    expect(timeZoneOptions(['Europe/Rome', 'America/Los_Angeles'], null)).toEqual([
      { value: DEFAULT_TIME_ZONE_OPTION, label: 'UTC (default)' },
      { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
      { value: 'Europe/Rome', label: 'Europe/Rome' },
    ])
  })

  it('keeps a stored zone the browser does not list, so the select can show it', () => {
    const options = timeZoneOptions(['Europe/Rome'], 'Asia/Calcutta')

    expect(options.map((option) => option.value)).toEqual([DEFAULT_TIME_ZONE_OPTION, 'Asia/Calcutta', 'Europe/Rome'])
  })

  it('maps the stored zone to a select value and back, with null as the default option', () => {
    expect(timeZoneOptionFor(null)).toBe(DEFAULT_TIME_ZONE_OPTION)
    expect(timeZoneOptionFor('Europe/Rome')).toBe('Europe/Rome')
    expect(timeZoneFromOption(DEFAULT_TIME_ZONE_OPTION)).toBeNull()
    expect(timeZoneFromOption('Europe/Rome')).toBe('Europe/Rome')
  })
})
