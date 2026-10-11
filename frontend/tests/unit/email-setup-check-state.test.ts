import { describe, expect, it } from 'vitest'

import type { EmailMailboxSetupCheck } from '@/lib/api-email-channel'
import {
  advanceSetupCheck,
  initialSetupCheckState,
  setupCheckNextRequest,
  SETUP_CHECK_TIMEOUT_MS,
  type SetupCheckState,
} from '@/lib/email-setup-check-state'

const check = (
  step: EmailMailboxSetupCheck['step'],
  status: EmailMailboxSetupCheck['status'],
): EmailMailboxSetupCheck => ({
  step,
  status,
  startedAt: '2026-10-03T10:00:00.000Z',
  passedAt: status === 'passed' ? '2026-10-03T10:01:00.000Z' : null,
  instructions: { sendTo: step === 'base' ? 'support@customer.test' : 'support+check@customer.test' },
})

const idle: SetupCheckState = { phase: 'idle' }

describe('email setup check state', () => {
  it('checks the base address, then the plus address, and stops polling once both arrive', () => {
    let state = advanceSetupCheck(idle, { type: 'start' })
    expect(setupCheckNextRequest(state)).toEqual({ kind: 'start', step: 'base' })

    state = advanceSetupCheck(state, { type: 'started', check: check('base', 'waiting'), nowMs: 0 })
    expect(state).toMatchObject({ phase: 'waiting', step: 'base', sendTo: 'support@customer.test' })
    expect(setupCheckNextRequest(state)).toEqual({ kind: 'poll' })

    const stillWaiting = advanceSetupCheck(state, { type: 'polled', check: check('base', 'waiting'), nowMs: 2_000 })
    expect(stillWaiting).toBe(state)

    state = advanceSetupCheck(stillWaiting, { type: 'polled', check: check('base', 'passed'), nowMs: 4_000 })
    expect(state).toEqual({ phase: 'starting', step: 'plus_address' })
    expect(setupCheckNextRequest(state)).toEqual({ kind: 'start', step: 'plus_address' })

    state = advanceSetupCheck(state, { type: 'started', check: check('plus_address', 'waiting'), nowMs: 5_000 })
    expect(state).toMatchObject({ phase: 'waiting', step: 'plus_address', sendTo: 'support+check@customer.test' })

    state = advanceSetupCheck(state, { type: 'polled', check: check('plus_address', 'passed'), nowMs: 7_000 })
    expect(state).toEqual({ phase: 'passed' })
    expect(setupCheckNextRequest(state)).toBeNull()
  })

  it('times out a step that never arrives, and retries that same step', () => {
    const waiting = advanceSetupCheck(
      advanceSetupCheck(advanceSetupCheck(idle, { type: 'start' }), { type: 'started', check: check('base', 'passed'), nowMs: 0 }),
      { type: 'started', check: check('plus_address', 'waiting'), nowMs: 1_000 },
    )
    expect(waiting).toMatchObject({ phase: 'waiting', step: 'plus_address' })

    const almost = advanceSetupCheck(waiting, { type: 'polled', check: check('plus_address', 'waiting'), nowMs: 1_000 + SETUP_CHECK_TIMEOUT_MS - 1 })
    expect(almost).toBe(waiting)

    const timedOut = advanceSetupCheck(waiting, { type: 'polled', check: check('plus_address', 'waiting'), nowMs: 1_000 + SETUP_CHECK_TIMEOUT_MS })
    expect(timedOut).toEqual({ phase: 'timed_out', step: 'plus_address' })
    expect(setupCheckNextRequest(timedOut)).toBeNull()

    expect(advanceSetupCheck(timedOut, { type: 'start' })).toEqual({ phase: 'starting', step: 'plus_address' })
  })

  it('ignores a poll that reports another step', () => {
    const waiting = advanceSetupCheck(
      { phase: 'starting', step: 'plus_address' },
      { type: 'started', check: check('plus_address', 'waiting'), nowMs: 0 },
    )
    expect(advanceSetupCheck(waiting, { type: 'polled', check: check('base', 'passed'), nowMs: 2_000 })).toBe(waiting)
    expect(advanceSetupCheck(waiting, { type: 'polled', check: null, nowMs: 2_000 })).toBe(waiting)
  })

  it('reports a failed request and retries the step it failed on', () => {
    const failed = advanceSetupCheck({ phase: 'starting', step: 'base' }, { type: 'request_failed', message: 'Mailbox not found.' })
    expect(failed).toEqual({ phase: 'failed', step: 'base', message: 'Mailbox not found.' })
    expect(setupCheckNextRequest(failed)).toBeNull()
    expect(advanceSetupCheck(failed, { type: 'start' })).toEqual({ phase: 'starting', step: 'base' })
  })

  it('resumes polling a check the mailbox already has open', () => {
    expect(initialSetupCheckState(check('plus_address', 'waiting'), 0)).toMatchObject({
      phase: 'waiting',
      step: 'plus_address',
      sendTo: 'support+check@customer.test',
    })
    expect(initialSetupCheckState(check('base', 'passed'), 0)).toEqual({ phase: 'idle' })
    expect(initialSetupCheckState(null, 0)).toEqual({ phase: 'idle' })
  })
})
