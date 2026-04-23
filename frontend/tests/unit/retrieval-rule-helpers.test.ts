import { describe, expect, it } from 'vitest'

import {
  createMetadataCondition,
  getOperatorDescription,
  getOperatorLabel,
  getRuleConditions,
  getRuleBehaviorLabel,
  getRuleEffectDescription,
  getRuleEffectLabel,
  getRulePreviewLabel,
  getRuleValuePlaceholder,
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

  it('uses date-friendly operator labels for date rules', () => {
    expect(getOperatorLabel('gt', 'date')).toBe('Is after')
    expect(getOperatorDescription('gte', 'date')).toContain('on or later')
    expect(getOperatorLabel('contains', 'string')).toBe('Contains')
  })

  it('returns clearer effect labels and previews', () => {
    expect(getRuleEffectLabel('boost')).toBe('Prefer match')
    expect(getRuleEffectDescription('filter')).toContain('Only keep results')
    expect(
      getRulePreviewLabel({
        id: 'preview',
        field: 'dateFrom',
        valueType: 'date',
        operator: 'gte',
        value: 'today()',
        effect: 'boost',
        enabled: true,
        triggerMode: 'always_on',
      })
    ).toBe('Prefer match: dateFrom is on or after today()')
    expect(
      getRulePreviewLabel({
        id: 'grouped',
        field: 'dateFrom',
        valueType: 'date',
        operator: 'gte',
        value: 'today()',
        combinator: 'and',
        conditions: [
          createMetadataCondition({
            id: 'one',
            field: 'dateFrom',
            valueType: 'date',
            operator: 'gte',
            value: 'today()',
          }),
          createMetadataCondition({
            id: 'two',
            field: 'category',
            valueType: 'string',
            operator: 'equals',
            value: 'event',
          }),
        ],
        effect: 'filter',
        enabled: true,
        triggerMode: 'always_on',
      })
    ).toContain('AND')
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
    expect(conditions[0]?.field).toBe('language')
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
    ).toContain('matches the intent')
  })

  it('returns readable placeholders', () => {
    expect(getRuleValuePlaceholder('date')).toBe('2026-03-26')
    expect(getRuleValuePlaceholder('number')).toBe('100')
    expect(getRuleValuePlaceholder('string')).toContain('example.com')
  })
})
