import { describe, expect, it } from 'vitest'

import {
  MAILBOX_LIMIT_BOUNDS,
  mailboxLimitsChange,
  mailboxLimitsDraft,
  parseMailboxLimit,
} from '@/lib/email-mailbox-limits'

const saved = {
  threadSendBudget: 3,
  hourlyGenerationBudget: 30,
  silenceThresholdHours: 72,
}

describe('parseMailboxLimit', () => {
  it('accepts whole numbers inside the contract bounds, ignoring surrounding space', () => {
    expect(parseMailboxLimit('threadSendBudget', '1')).toEqual({ ok: true, value: 1 })
    expect(parseMailboxLimit('threadSendBudget', ' 20 ')).toEqual({ ok: true, value: 20 })
    expect(parseMailboxLimit('hourlyGenerationBudget', '1000')).toEqual({ ok: true, value: 1000 })
    expect(parseMailboxLimit('silenceThresholdHours', '2160')).toEqual({ ok: true, value: 2160 })
  })

  it('refuses values outside the bounds, naming the range', () => {
    expect(parseMailboxLimit('threadSendBudget', '0')).toEqual({ ok: false, error: 'Enter a whole number from 1 to 20.' })
    expect(parseMailboxLimit('threadSendBudget', '21')).toEqual({ ok: false, error: 'Enter a whole number from 1 to 20.' })
    expect(parseMailboxLimit('hourlyGenerationBudget', '1001').ok).toBe(false)
    expect(parseMailboxLimit('silenceThresholdHours', '2161').ok).toBe(false)
  })

  it('refuses anything that is not a plain whole number', () => {
    for (const raw of ['', '   ', '-3', '1.5', '3e1', '0x10', 'five', '+4', '1 2']) {
      expect(parseMailboxLimit('threadSendBudget', raw)).toEqual({ ok: false, error: 'Enter a whole number from 1 to 20.' })
    }
  })

  it('takes its bounds from the mailbox contract', () => {
    expect(MAILBOX_LIMIT_BOUNDS).toEqual({
      threadSendBudget: [1, 20],
      hourlyGenerationBudget: [1, 1000],
      silenceThresholdHours: [1, 2160],
    })
  })
})

describe('mailboxLimitsChange', () => {
  it('is empty when the draft matches the saved mailbox', () => {
    expect(mailboxLimitsChange(saved, mailboxLimitsDraft(saved))).toEqual({ change: {}, errors: {} })
  })

  it('carries only the fields that differ, as numbers', () => {
    const draft = { ...mailboxLimitsDraft(saved), threadSendBudget: '5' }
    expect(mailboxLimitsChange(saved, draft)).toEqual({ change: { threadSendBudget: 5 }, errors: {} })
  })

  it('treats a re-typed equal value as unchanged', () => {
    const draft = { ...mailboxLimitsDraft(saved), hourlyGenerationBudget: ' 30 ' }
    expect(mailboxLimitsChange(saved, draft)).toEqual({ change: {}, errors: {} })
  })

  it('reports each invalid field and leaves it out of the change', () => {
    const draft = { ...mailboxLimitsDraft(saved), threadSendBudget: '0', hourlyGenerationBudget: '2000', silenceThresholdHours: '48' }
    expect(mailboxLimitsChange(saved, draft)).toEqual({
      change: { silenceThresholdHours: 48 },
      errors: {
        threadSendBudget: 'Enter a whole number from 1 to 20.',
        hourlyGenerationBudget: 'Enter a whole number from 1 to 1000.',
      },
    })
  })
})
