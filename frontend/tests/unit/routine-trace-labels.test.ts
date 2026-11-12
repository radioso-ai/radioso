import { describe, expect, it } from 'vitest'

import type { ConversationTraceStage } from '@/lib/api'
import { buildRoutineRunTrace } from '@/lib/routine-run-trace'
import { routineEventDescription, routineEventLabel } from '@/lib/routine-trace-labels'

const consentStep = (event: string, consent: Record<string, unknown>) => {
  const stage: ConversationTraceStage = {
    id: 'routine:class',
    kind: 'routine_resume',
    status: 'applied',
    outputs: { routineId: 'class' },
    subTrace: {
      namespace: 'routine',
      version: 1,
      payload: { steps: [{ stepId: 'consent:health:ask_injury', kind: 'consent', event, consent }] },
    },
  }
  return buildRoutineRunTrace(stage)!.steps[0]
}

// #1544: a consent step's trace carries the consent key and codes; the inspector says what happened.
describe('a consent step in the turn inspector', () => {
  it('keeps the consent key and codes from the trace, and nothing else it carries', () => {
    expect(consentStep('consent_decided', { key: 'health', decision: 'declined', defaulted: true, body: 'never shown' }).consent)
      .toEqual({ key: 'health', decision: 'declined', defaulted: true })
    expect(consentStep('consent_asked', { decision: 'granted' }).consent).toBeUndefined()
  })

  it('tells a first ask from one shown again after an unclear reply', () => {
    expect(routineEventLabel(consentStep('consent_asked', { key: 'health' }))).toBe('Asked consent')
    expect(routineEventDescription(consentStep('consent_asked', { key: 'health' }))).toMatch(/waits for the visitor/)
    expect(routineEventDescription(consentStep('consent_asked', { key: 'health', reask: true }))).toMatch(/unclear/)
  })

  it('tells an agreement, a refusal and a decline counted after two unclear replies apart', () => {
    expect(routineEventDescription(consentStep('consent_decided', { key: 'health', decision: 'granted' }))).toMatch(/agreed/)
    expect(routineEventDescription(consentStep('consent_decided', { key: 'health', decision: 'declined' }))).toMatch(/declined/)
    expect(routineEventDescription(consentStep('consent_decided', { key: 'health', decision: 'declined', defaulted: true })))
      .toMatch(/asking twice/)
  })

  it('says why a consent was not asked', () => {
    expect(routineEventLabel(consentStep('consent_skipped', { key: 'health', reason: 'channel' }))).toBe('Consent not asked')
    expect(routineEventDescription(consentStep('consent_skipped', { key: 'health', reason: 'channel' }))).toMatch(/channel asks no consent/)
    expect(routineEventDescription(consentStep('consent_skipped', { key: 'health', reason: 'wording_unavailable' }))).toMatch(/No wording/)
  })
})
