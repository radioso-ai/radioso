import { describe, expect, it } from 'vitest'

import { formatBindingLine, guardToSentence } from '@/lib/routine-document'

describe('routine document helpers', () => {
  const slots = new Map([['email', 'Customer email'], ['attempts', 'Attempts']])
  type GuardSentenceInput = Parameters<typeof guardToSentence>[0]
  const guardFixture = (overrides: Partial<GuardSentenceInput>): GuardSentenceInput => ({
    kind: 'default',
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    fieldRef: null,
    fieldOp: null,
    fieldValue: null,
    fieldValues: null,
    fieldUnit: null,
    ...overrides,
  })

  it('renders every typed guard as a readable condition', () => {
    expect(guardToSentence(guardFixture({ kind: 'llm', guardText: 'the request needs escalation' }), slots)).toBe('the request needs escalation')
    expect(guardToSentence(guardFixture({ kind: 'default' }), slots)).toBe('Otherwise')
    expect(guardToSentence(guardFixture({ kind: 'slot_filled', guardText: '{{slot.email}} {{slot.attempts}}', slotKeys: ['email', 'attempts'] }), slots)).toBe('when Customer email and Attempts are provided')
    expect(guardToSentence(guardFixture({ kind: 'outcome', outcomeStatus: 'failed' }), slots)).toBe('outcome is failed')
    expect(guardToSentence(guardFixture({ kind: 'counter', counterLimit: 3 }), slots)).toBe('after 3 attempts')
    expect(guardToSentence(guardFixture({ kind: 'field', fieldRef: 'email', fieldOp: 'is_present' }), slots)).toBe('Customer email is present')
  })

  it('assembles inputs and outputs into the uses-to-sets line', () => {
    expect(formatBindingLine(
      {
        email: { kind: 'variableRef', ref: 'email' },
        source: { kind: 'contextVariableRef', contextVariable: 'conversation_id' },
        retry: { kind: 'literal', value: true },
      },
      { customer_id: 'customerId' },
    )).toBe('uses email = email, source = context.conversation_id, retry = true → sets customer_id = customerId')
  })

  it('omits an empty uses-to-sets line', () => {
    expect(formatBindingLine({}, {})).toBeNull()
  })
})
