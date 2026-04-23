import { describe, expect, it } from 'vitest'

import {
  getRuleBehaviorLabel,
  getRuleValuePlaceholder,
  isDynamicTodayValue,
  operatorOptionsForValueType,
} from '@/components/dashboard/settings/retrieval-rule-helpers'

describe('retrieval rule helpers', () => {
  it('limits operators by value type', () => {
    expect(operatorOptionsForValueType('string')).toEqual(['equals', 'not_equals', 'contains', 'not_contains'])
    expect(operatorOptionsForValueType('boolean')).toEqual(['equals', 'not_equals'])
    expect(operatorOptionsForValueType('date')).toEqual(['equals', 'not_equals', 'lt', 'lte', 'gt', 'gte'])
  })

  it('detects today() tokens', () => {
    expect(isDynamicTodayValue('today()')).toBe(true)
    expect(isDynamicTodayValue(' TODAY() ')).toBe(true)
    expect(isDynamicTodayValue('2026-04-23')).toBe(false)
  })

  it('describes rule behavior in plain language', () => {
    expect(
      getRuleBehaviorLabel({
        id: 'always-on',
        field: 'language',
        valueType: 'string',
        operator: 'equals',
        value: 'en',
        effect: 'boost',
        enabled: true,
        triggerMode: 'always_on',
      })
    ).toContain('Always active')

    expect(
      getRuleBehaviorLabel({
        id: 'triggered',
        field: 'dateFrom',
        valueType: 'date',
        operator: 'gte',
        value: 'today()',
        effect: 'filter',
        enabled: true,
        triggerMode: 'match_turn',
        triggerInstruction: 'Enact for upcoming events.',
      })
    ).toContain('Activates only when this turn matches')
  })

  it('returns readable placeholders', () => {
    expect(getRuleValuePlaceholder('date')).toBe('2026-03-26')
    expect(getRuleValuePlaceholder('number')).toBe('100')
    expect(getRuleValuePlaceholder('string')).toContain('example.com')
  })
})
