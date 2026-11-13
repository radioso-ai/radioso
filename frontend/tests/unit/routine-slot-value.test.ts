import { describe, expect, it } from 'vitest'

import { formatSlotValue } from '@/lib/routine-slot-value'

describe('formatSlotValue', () => {
  it('shows a scalar as it is and nothing for an empty slot', () => {
    expect(formatSlotValue('Mitte')).toBe('Mitte')
    expect(formatSlotValue(3)).toBe('3')
    expect(formatSlotValue(true)).toBe('true')
    expect(formatSlotValue(undefined)).toBe('')
  })

  it('shows a picked card by its title (#1763)', () => {
    expect(formatSlotValue({ key: '/results/1', title: 'Villa Rosa', link: 'https://homes.example/villa-rosa', fields: { rooms: 3 } }))
      .toBe('Villa Rosa')
  })

  it('shows any other structured value as JSON', () => {
    expect(formatSlotValue({ id: 'yes', payload: { note: 'ok' } })).toBe('{"id":"yes","payload":{"note":"ok"}}')
  })
})
