import { describe, expect, it } from 'vitest'

import {
  buildApiRequestConfig,
  buildApiTestInput,
  createApiRequestDraft,
  emptyApiInput,
  fixedValueFromText,
  withOutputFromValue,
} from '@/components/dashboard/settings/skills/api-request-skill-model'
import { isAddressablePath, listOutputFor, scalarOutputFor } from '@/components/dashboard/settings/skills/api-response-tree'
import { coerceApiTestSample } from '@/components/dashboard/settings/skills/api-test-sample-values'
import { guardOpIsInvalidForList } from '@/lib/routine-skill-outputs'

describe('response tree addressing', () => {
  it('refuses paths the backend cannot read back', () => {
    expect(isAddressablePath(['order', 'status', 0])).toBe(true)
    expect(isAddressablePath(['@odata.count'])).toBe(false)
    expect(isAddressablePath(['a b'])).toBe(false)
    expect(isAddressablePath(['a', '__proto__'])).toBe(false)
    expect(isAddressablePath(['constructor'])).toBe(false)
    expect(isAddressablePath(['prototype'])).toBe(false)
    expect(isAddressablePath(Array.from({ length: 11 }, () => 'k'))).toBe(false)
  })

  it('makes no output of an unaddressable scalar or list', () => {
    expect(scalarOutputFor(['@odata.count'], 5)).toBeNull()
    expect(scalarOutputFor(['count'], 5)).not.toBeNull()
    expect(listOutputFor(['my rows'], [{ id: 1 }])).toBeNull()
    expect(withOutputFromValue([], ['a b'], 'x')).toEqual([])
  })
})

describe('fixed parameter text', () => {
  it('keeps a number that does not round-trip as text', () => {
    expect(fixedValueFromText('12345678901234567890')).toBe('12345678901234567890')
    expect(fixedValueFromText('9007199254740993')).toBe('9007199254740993')
    expect(fixedValueFromText('1e5')).toBe('1e5')
    expect(fixedValueFromText('007')).toBe('007')
  })

  it('still types numbers, booleans, null, objects and arrays', () => {
    expect(fixedValueFromText('42')).toBe(42)
    expect(fixedValueFromText(' 1.5 ')).toBe(1.5)
    expect(fixedValueFromText('true')).toBe(true)
    expect(fixedValueFromText('null')).toBeNull()
    expect(fixedValueFromText('{"a":1}')).toEqual({ a: 1 })
    expect(fixedValueFromText('[1,2]')).toEqual([1, 2])
    expect(fixedValueFromText('EUR')).toBe('EUR')
  })

  it('shows a stored large-number string unchanged', () => {
    const config = { method: 'GET', path: '/x', boundParams: { id: '12345678901234567890' }, exposedParams: {}, outputs: {} }
    const draft = createApiRequestDraft(config)
    expect(draft.fixedParams[0].value).toBe('12345678901234567890')
    expect(buildApiRequestConfig(draft).boundParams).toEqual({ id: '12345678901234567890' })
  })
})

describe('list-invalid guard state', () => {
  it('flags only list variables', () => {
    expect(guardOpIsInvalidForList('gt', 'text', false)).toBe(false)
    expect(guardOpIsInvalidForList('gt', 'text', true)).toBe(true)
    expect(guardOpIsInvalidForList('is_present', 'text', true)).toBe(false)
  })
})

describe('test sample coercion', () => {
  it('converts by declared type', () => {
    expect(coerceApiTestSample('number', ' 42 ')).toBe(42)
    expect(coerceApiTestSample('number', '-1.5')).toBe(-1.5)
    expect(coerceApiTestSample('boolean', 'TRUE')).toBe(true)
    expect(coerceApiTestSample('boolean', 'false')).toBe(false)
    expect(coerceApiTestSample('date', '2026-03-04T10:20:30Z')).toBe('2026-03-04')
    expect(coerceApiTestSample('date', '2026-03-04')).toBe('2026-03-04')
    expect(coerceApiTestSample('text', '  hi ')).toBe('hi')
    expect(coerceApiTestSample('email', ' a@b.example ')).toBe('a@b.example')
  })

  it('sends a sample that does not convert as typed', () => {
    expect(coerceApiTestSample('number', '1e5')).toBe('1e5')
    expect(coerceApiTestSample('boolean', 'yes')).toBe('yes')
    expect(coerceApiTestSample('date', '2026-02-30')).toBe('2026-02-30')
    expect(coerceApiTestSample('email', 'nope')).toBe('nope')
  })

  it('types the test request samples', () => {
    const draft = createApiRequestDraft({ method: 'POST', path: '/x', boundParams: {}, exposedParams: {}, outputs: {} })
    const count = { ...emptyApiInput(), key: 'count', type: 'number' as const }
    const when = { ...emptyApiInput(), key: 'when', type: 'date' as const }
    const input = buildApiTestInput({ ...draft, inputs: [count, when] }, { [count.id]: '42', [when.id]: '2026-03-04T10:00:00' })
    expect(input.exposedSampleValues).toEqual({ count: 42, when: '2026-03-04' })
  })
})
