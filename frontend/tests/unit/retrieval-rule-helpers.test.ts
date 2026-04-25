import { describe, expect, it } from 'vitest'

import {
  getRuleConditions,
  isIsoDateValue,
  isValidDateRuleValue,
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

  it('validates date rule values', () => {
    expect(isIsoDateValue('2026-04-23')).toBe(true)
    expect(isIsoDateValue('23-04-2026')).toBe(false)
    expect(isValidDateRuleValue('today()')).toBe(true)
    expect(isValidDateRuleValue('2026-04-23')).toBe(true)
    expect(isValidDateRuleValue('23.04.2026')).toBe(false)
  })

  it('falls back to a single condition for legacy rules', () => {
    const conditions = getRuleConditions({
      id: 'legacy',
      field: 'language',
      valueType: 'string',
      operator: 'equals',
      value: 'en',
      effect: 'boost',
      enabled: true,
      triggerMode: 'always_on',
    })

    expect(conditions).toHaveLength(1)
    expect(conditions[0]).toBeDefined()
  })
})
