import { describe, expect, it } from 'vitest'

import { QUALITY_SIGNAL_IDS } from '@/lib/api-quality'
import { ACTIVE_TRIAGE_STATES, resolveQueueScope } from '@/lib/quality-signals'

describe('resolveQueueScope', () => {
  it('defaults the queue to every signal in an active triage state', () => {
    expect(resolveQueueScope({ showAll: false, signal: null, triageStates: [] })).toEqual({
      signals: [...QUALITY_SIGNAL_IDS],
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
      signals: [...QUALITY_SIGNAL_IDS],
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
