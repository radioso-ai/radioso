import { describe, expect, it } from 'vitest'

import { validateTestValueInputs } from '@/lib/agent-revision-test-values'

describe('revision test value validation', () => {
  const variables = [
    { id: 'json-a', name: 'Payload A', valueType: 'json' as const },
    { id: 'json-b', name: 'Payload B', valueType: 'json' as const },
    { id: 'text', name: 'Note', valueType: 'string' as const },
  ]

  it('retains every invalid field while accepting valid fields', () => {
    const result = validateTestValueInputs(variables, {
      'json-a': '{bad',
      'json-b': '{"ok":true}',
      text: 'ready',
    })

    expect(result.errors).toEqual({ 'json-a': 'Payload A must contain valid JSON.' })
    expect(result.values).toEqual([
      { contextVariableId: 'json-b', value: { ok: true } },
      { contextVariableId: 'text', value: 'ready' },
    ])
  })

  it('keeps JSON false and null as intentional sample values', () => {
    expect(validateTestValueInputs(variables, {
      'json-a': 'false',
      'json-b': 'null',
      text: '',
    }).values).toEqual([
      { contextVariableId: 'json-a', value: false },
      { contextVariableId: 'json-b', value: null },
    ])
  })

  it('sends a Yes/no sample as a boolean, a number as a number and a date as written', () => {
    const typed = [
      { id: 'flag', name: 'VIP', valueType: 'boolean' as const },
      { id: 'count', name: 'Party size', valueType: 'number' as const },
      { id: 'day', name: 'Arrival', valueType: 'date' as const },
    ]
    expect(validateTestValueInputs(typed, { flag: 'false', count: '4', day: '2026-11-24' })).toEqual({
      values: [
        { contextVariableId: 'flag', value: false },
        { contextVariableId: 'count', value: 4 },
        { contextVariableId: 'day', value: '2026-11-24' },
      ],
      errors: {},
    })
  })

  it('refuses a number sample that is not a number', () => {
    const result = validateTestValueInputs([{ id: 'count', name: 'Party size', valueType: 'number' as const }], { count: 'four' })
    expect(result).toEqual({ values: [], errors: { count: 'Party size must be a number.' } })
  })
})
