import { describe, expect, it } from 'vitest'

import {
  buildEvalPromotionPayload,
  buildQualityTurnWorkbenchRoute,
} from '@/lib/workbench-handoffs'

describe('workbench handoff builders', () => {
  it('builds a seeded agent workbench route from a quality turn', () => {
    expect(buildQualityTurnWorkbenchRoute({
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      assistantMessageId: 'assistant-message-1',
    }, {
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'workspace-key',
    })).toEqual({
      section: 'agents',
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'workspace-key',
      agentId: 'agent-1',
      agentTab: 'chat',
      workbenchConversationId: 'conversation-1',
      workbenchMessageId: 'assistant-message-1',
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
