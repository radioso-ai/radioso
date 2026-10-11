import type { EmailMailboxSetupCheck, EmailSetupCheckStep } from '@/lib/api-email-channel'

/** How often a waiting check re-reads its mailbox. */
export const SETUP_CHECK_POLL_MS = 2_000
/** How long one step waits for its message before the operator is asked to check forwarding. */
export const SETUP_CHECK_TIMEOUT_MS = 10 * 60_000

/**
 * The mailbox setup check, as the settings card drives it: send a message to
 * the real address (`base`), then to a plus-addressed variant
 * (`plus_address`), and wait for each to arrive through the relay. A step that
 * does not arrive in time stops polling, so a removed forwarding rule cannot
 * poll forever.
 */
export type SetupCheckState =
  | { phase: 'idle' }
  | { phase: 'starting'; step: EmailSetupCheckStep }
  | { phase: 'waiting'; step: EmailSetupCheckStep; sendTo: string; deadlineMs: number }
  | { phase: 'passed' }
  | { phase: 'timed_out'; step: EmailSetupCheckStep }
  | { phase: 'failed'; step: EmailSetupCheckStep; message: string }

type SetupCheckEvent =
  | { type: 'start' }
  | { type: 'started'; check: EmailMailboxSetupCheck; nowMs: number }
  | { type: 'polled'; check: EmailMailboxSetupCheck | null; nowMs: number }
  | { type: 'request_failed'; message: string }

type SetupCheckRequest = { kind: 'start'; step: EmailSetupCheckStep } | { kind: 'poll' }

const afterPassing = (step: EmailSetupCheckStep): SetupCheckState =>
  step === 'base' ? { phase: 'starting', step: 'plus_address' } : { phase: 'passed' }

const waitingFor = (check: EmailMailboxSetupCheck, nowMs: number): SetupCheckState => ({
  phase: 'waiting',
  step: check.step,
  sendTo: check.instructions.sendTo,
  deadlineMs: nowMs + SETUP_CHECK_TIMEOUT_MS,
})

/** A check the mailbox already has open resumes with a fresh wait; anything else starts idle. */
export function initialSetupCheckState(check: EmailMailboxSetupCheck | null, nowMs: number): SetupCheckState {
  return check?.status === 'waiting' ? waitingFor(check, nowMs) : { phase: 'idle' }
}

export function advanceSetupCheck(state: SetupCheckState, event: SetupCheckEvent): SetupCheckState {
  switch (event.type) {
    case 'start':
      if (state.phase === 'timed_out' || state.phase === 'failed') return { phase: 'starting', step: state.step }
      if (state.phase === 'idle' || state.phase === 'passed') return { phase: 'starting', step: 'base' }
      return state
    case 'started':
      if (state.phase !== 'starting' || event.check.step !== state.step) return state
      return event.check.status === 'passed' ? afterPassing(state.step) : waitingFor(event.check, event.nowMs)
    case 'polled':
      if (state.phase !== 'waiting') return state
      if (event.check?.step === state.step && event.check.status === 'passed') return afterPassing(state.step)
      return event.nowMs >= state.deadlineMs ? { phase: 'timed_out', step: state.step } : state
    case 'request_failed':
      if (state.phase !== 'starting' && state.phase !== 'waiting') return state
      return { phase: 'failed', step: state.step, message: event.message }
  }
}

/** The request the card owes the current state, if any. */
export function setupCheckNextRequest(state: SetupCheckState): SetupCheckRequest | null {
  if (state.phase === 'starting') return { kind: 'start', step: state.step }
  if (state.phase === 'waiting') return { kind: 'poll' }
  return null
}
