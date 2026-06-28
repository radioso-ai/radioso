import { describe, expect, it } from 'vitest'

import {
  buildEvalPromotionPayload,
  buildQualityTurnEvalRoute,
} from '@/lib/workbench-handoffs'

describe('workbench handoff builders', () => {
  it('builds an eval case route from a quality-created case', () => {
    expect(buildQualityTurnEvalRoute('case-1', {
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'workspace-key',
    })).toEqual({
      section: 'eval',
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'workspace-key',
      evalCaseId: 'case-1',
    })
  })

  it('builds eval capture, case, and override run payloads from a workbench run', () => {
    expect(buildEvalPromotionPayload({
      conversationId: 'conversation-1',
      assistantMessageId: 'assistant-message-1',
      snapshotId: 'snapshot-1',
      name: 'Replay regression',
      originalAnswer: '  Replay answer.  ',
      agentConfigOverride: {
        customInstruction: 'Use the release note voice.',
        skillSettings: {
          'retrieval.answer': { vectorTopK: 3 },
        },
      },
    })).toEqual({
      captureSnapshot: {
        conversationId: 'conversation-1',
        messageId: 'assistant-message-1',
      },
      createCase: {
        snapshotId: 'snapshot-1',
        name: 'Replay regression',
        assertions: [{ type: 'llm_judge', expectedAnswer: 'Replay answer.' }],
      },
      runCase: {
        mode: 'full_assistant',
        overrides: {
          agentConfigOverride: {
            customInstruction: 'Use the release note voice.',
            skillSettings: {
              'retrieval.answer': { vectorTopK: 3 },
            },
          },
        },
      },
    })
  })
})
