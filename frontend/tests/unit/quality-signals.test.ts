import { describe, expect, it } from 'vitest'

import { QUALITY_SIGNAL_IDS } from '@/lib/api-quality'
import { ACTIVE_TRIAGE_STATES, DEFAULT_QUALITY_SIGNAL_IDS, resolveQueueScope } from '@/lib/quality-signals'

describe('resolveQueueScope', () => {
  // #1575: unmet directives is the answer's own grade of itself, so it is opt-in: its chip
  // narrows to it, but the default queue and the Inbox count leave it out.
  it('defaults the queue to every signal except the opt-in ones, in an active triage state', () => {
    expect(resolveQueueScope({ showAll: false, signal: null, triageStates: [] })).toEqual({
      signals: QUALITY_SIGNAL_IDS.filter((id) => id !== 'unmet_directives'),
      triageStates: [...ACTIVE_TRIAGE_STATES],
    })
    expect(DEFAULT_QUALITY_SIGNAL_IDS).not.toContain('unmet_directives')
  })

  it('narrows to the opt-in unmet-directives signal when its chip is selected', () => {
    expect(resolveQueueScope({ showAll: false, signal: 'unmet_directives', triageStates: [] })).toEqual({
      signals: ['unmet_directives'],
      triageStates: [...ACTIVE_TRIAGE_STATES],
    })
  })

  it('narrows to the selected chip without widening triage', () => {
    expect(
      resolveQueueScope({ showAll: false, signal: 'grounding_gaps', triageStates: [] }),
    ).toEqual({
      signals: ['grounding_gaps'],
      triageStates: [...ACTIVE_TRIAGE_STATES],
    })
  })

  it('lets an explicit triage choice replace the active-backlog default', () => {
    expect(
      resolveQueueScope({ showAll: false, signal: null, triageStates: ['resolved'] }),
    ).toEqual({
      signals: [...DEFAULT_QUALITY_SIGNAL_IDS],
      triageStates: ['resolved'],
    })
  })

  it('drops both defaults when the operator asks for all answers', () => {
    expect(resolveQueueScope({ showAll: true, signal: null, triageStates: [] })).toEqual({
      signals: undefined,
      triageStates: undefined,
    })
  })

  it('keeps explicit filters when all answers is on', () => {
    expect(
      resolveQueueScope({ showAll: true, signal: null, triageStates: ['dismissed'] }),
    ).toEqual({
      signals: undefined,
      triageStates: ['dismissed'],
    })
  })
})
