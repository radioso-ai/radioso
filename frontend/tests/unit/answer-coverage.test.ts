import { describe, expect, it } from 'vitest'

import {
  answerCoverageAwareOutcome,
  answerCoverageLabel,
  answerCoverageOutcomePresentation,
  normalizeAnswerCoverage,
  normalizeAnswerCoverageInteractionTrace,
  compatibleAnswerCoverageReasons,
} from '@/lib/answer-coverage'
import type { DiagnosticPresentation } from '@/lib/activity-diagnostics'

describe('answer coverage wire normalization', () => {
  it('keeps assessed coverage and provenance', () => {
    const value = normalizeAnswerCoverage({
      availability: 'assessed', coverage: 'unanswered', reason: 'insufficient_evidence',
      contextualizedRequest: 'Can I attend for one day?', unresolvedRequest: 'Attendance rule',
      originatingTurnId: 'turn-1', originatingRequestId: 'request-1', schemaVersion: 1,
    })
    expect(value?.coverage).toBe('unanswered')
    expect(value?.originatingRequestId).toBe('request-1')
    expect(answerCoverageLabel(value?.coverage)).toBe('Unanswered')
  })

  it('keeps an API-valid assessed verdict when optional composition metadata is absent', () => {
    expect(normalizeAnswerCoverage({
      availability: 'assessed',
      coverage: 'partial',
      reason: 'insufficient_evidence',
      originatingTurnId: 'turn-1',
      originatingRequestId: 'request-1',
    })).toMatchObject({
      availability: 'assessed',
      coverage: 'partial',
      reason: 'insufficient_evidence',
    })
  })

  it('rejects an assessed verdict with an out-of-bounds optional schema version', () => {
    expect(normalizeAnswerCoverage({
      availability: 'assessed',
      coverage: 'answered',
      reason: 'sufficient_evidence',
      originatingTurnId: 'turn-1',
      originatingRequestId: 'request-1',
      schemaVersion: 0,
    })?.availability).toBe('invalid')
  })

  it('uses the backend any-compatible-coverage rule for reason choices', () => {
    expect(compatibleAnswerCoverageReasons(['answered', 'partial']))
      .toEqual(['sufficient_evidence', 'insufficient_evidence', 'conflicting_evidence', 'intentional_scope_boundary'])
    expect(compatibleAnswerCoverageReasons(['unanswered', 'unclear']))
      .toEqual(['insufficient_evidence', 'conflicting_evidence', 'intentional_scope_boundary', 'ambiguous_request'])
  })

  it('represents invalid or absent values as unavailable', () => {
    expect(normalizeAnswerCoverage({ availability: 'assessed', coverage: 'made_up' })).toBeUndefined()
    expect(normalizeAnswerCoverage(undefined)).toBeUndefined()
  })

  it('distinguishes evaluated no-match from not evaluated', () => {
    expect(normalizeAnswerCoverageInteractionTrace({ state: 'evaluated', decisions: [] })?.state).toBe('evaluated')
    expect(normalizeAnswerCoverageInteractionTrace({ state: 'not_evaluated', decisions: [] })?.state).toBe('not_evaluated')
  })

  it('keeps failed and historical assessments explicitly unassessed', () => {
    expect(normalizeAnswerCoverage({ availability: 'failed', originatingTurnId: 't', originatingRequestId: 'r' })?.coverage).toBeUndefined()
    expect(normalizeAnswerCoverage({ availability: 'not_recorded', originatingTurnId: 't', originatingRequestId: 'r' })?.availability).toBe('not_recorded')
  })
})

describe('answer coverage outcome presentation', () => {
  const fallback: DiagnosticPresentation = {
    title: 'Routine reply',
    summary: 'The routine answered directly.',
    facts: [],
    tone: 'ok',
  }

  it('does not replace an outcome when coverage was not attempted', () => {
    expect(answerCoverageAwareOutcome(fallback, {
      availability: 'not_recorded',
      originatingTurnId: 'turn-1',
      originatingRequestId: 'request-1',
    })).toEqual(fallback)
    expect(answerCoverageAwareOutcome(fallback)).toEqual(fallback)
  })

  it('uses assessed answered coverage as the authoritative outcome', () => {
    expect(answerCoverageAwareOutcome({
      ...fallback,
      title: 'Request unanswered',
      tone: 'warning',
    }, {
      availability: 'assessed',
      coverage: 'answered',
      reason: 'sufficient_evidence',
      originatingTurnId: 'turn-1',
      originatingRequestId: 'request-1',
      schemaVersion: 1,
    })).toMatchObject({
      title: 'Request answered',
      tone: 'ok',
    })
  })

  it('distinguishes a wholly unanswered request from a partial response', () => {
    expect(answerCoverageOutcomePresentation('unanswered')).toMatchObject({
      title: 'Request remains unanswered',
      tone: 'warning',
    })
    expect(answerCoverageOutcomePresentation('partial')).toMatchObject({
      title: 'Response leaves part of the request unresolved',
      tone: 'warning',
    })
  })
})
