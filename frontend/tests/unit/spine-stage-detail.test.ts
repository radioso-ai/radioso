import { describe, expect, it } from 'vitest'

import { buildClarificationStageDetail } from '@/components/dashboard/spine-stage-detail'
import type { ConversationTraceStage } from '@/lib/api'

describe('buildClarificationStageDetail', () => {
  it('extracts metadata-safe clarification fields and ignores candidate payloads', () => {
    const stage: ConversationTraceStage = {
      id: 'clarification',
      kind: 'clarification',
      status: 'applied',
      outputs: {
        surface: 'retrieval_sense',
        decision: 'asked',
        reason: 'too_close',
        margin: 0.03,
        candidates: [
          {
            id: 'hatha',
            label: 'Hatha yoga',
            confidence: 0.73,
            payload: { documentContent: 'must not render' },
          },
        ],
        mappingOutcome: { outcome: 'chosen', candidateId: 'hatha' },
      },
    }

    expect(buildClarificationStageDetail(stage)).toEqual({
      surface: 'retrieval_sense',
      decision: 'asked',
      reason: 'too_close',
      margin: 0.03,
      candidates: [{ id: 'hatha', label: 'Hatha yoga', confidence: 0.73 }],
      mappingOutcome: '{"outcome":"chosen","candidateId":"hatha"}',
    })
  })
})
