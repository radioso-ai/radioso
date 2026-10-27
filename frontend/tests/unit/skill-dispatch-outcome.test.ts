import { describe, expect, it } from 'vitest'

import { skillDispatchOutcome, skillOutcomeLabel } from '@/lib/skill-dispatch-outcome'

describe('skillOutcomeLabel', () => {
  it('says a skill the turn policy kept from running was not called, and why', () => {
    expect(skillOutcomeLabel({ status: 'failed', reason: 'suppressed_for_safe_test' })).toBe(
      'not called (skills are off in this test)',
    )
    expect(skillOutcomeLabel({ status: 'failed', reason: 'requires_durable_conversation' })).toBe(
      'not called (needs a saved conversation; runs after publish)',
    )
  })

  it('pairs any other reason with the status it ended in', () => {
    expect(skillOutcomeLabel({ status: 'failed', reason: 'mcp_timeout' })).toBe('failed (mcp timeout)')
    expect(skillOutcomeLabel({ reason: 'empty_answer' })).toBe('empty answer')
  })

  it('falls back to the status alone, and to nothing without either', () => {
    expect(skillOutcomeLabel({ status: 'awaiting_confirmation' })).toBe('awaiting confirmation')
    expect(skillOutcomeLabel({})).toBeUndefined()
  })

  it('does not read an inherited property name as a known reason', () => {
    expect(skillOutcomeLabel({ status: 'failed', reason: 'constructor' })).toBe('failed (constructor)')
  })
})

describe('skillDispatchOutcome', () => {
  it('reads why a dispatched skill did not answer from its stage outputs', () => {
    expect(
      skillDispatchOutcome({ skillName: 'order_lookup', outcomeStatus: 'failed', failureReason: 'suppressed_for_safe_test' }),
    ).toEqual({ outcome: 'not called (skills are off in this test)' })
  })

  it('names the skill a fallback dispatch answered in place of', () => {
    expect(
      skillDispatchOutcome({ skillName: 'retrieval.answer', outcomeStatus: 'completed', fallbackFor: 'order_lookup' }),
    ).toEqual({ outcome: 'completed', fallbackNote: 'in place of order_lookup' })
  })

  it('reads nothing from a stage without outputs', () => {
    expect(skillDispatchOutcome(undefined)).toEqual({})
  })
})
