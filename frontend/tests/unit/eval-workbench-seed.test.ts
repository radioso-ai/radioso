import { describe, expect, it } from 'vitest'

import { buildEvalSeedTurn, eventRetrievalWorkbenchSeedCases } from '@/lib/eval-workbench-seed'
import type { EvalSnapshot } from '@/lib/api-eval'

const snapshot = (overrides: Partial<EvalSnapshot>): EvalSnapshot => ({
  id: 'snapshot-1',
  workspaceId: 'workspace-1',
  sourceConversationId: 'conversation-1',
  sourceMessageId: null,
  replayTarget: null,
  fidelity: 'full',
  messages: [],
  originalInstructionBlock: null,
  originalModelId: null,
  originalRetrievalSettings: null,
  originalRetrievalResult: null,
  originalAgent: null,
  originalAgentConfig: null,
  sourceAgentId: 'agent-1',
  originalRoutineState: null,
  capturedAt: '2026-06-30T10:00:00.000Z',
  capturedBy: null,
  ...overrides,
})

const message = (
  id: string,
  role: EvalSnapshot['messages'][number]['role'],
  content = id,
): EvalSnapshot['messages'][number] => ({
  id,
  role,
  content,
  createdAt: '2026-06-30T10:00:00.000Z',
})

describe('eval workbench seed', () => {
  it('exposes event retrieval seed cases with evidence and order assertions', () => {
    expect(eventRetrievalWorkbenchSeedCases.map((evalCase) => evalCase.id)).toEqual([
      'event-date-cross-paragraph',
      'event-next-events-listing',
      'event-actuality-sort',
    ])
    expect(eventRetrievalWorkbenchSeedCases[0]?.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'retrieval_chunk_metadata' }),
      ]),
    )
    expect(eventRetrievalWorkbenchSeedCases[1]?.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'retrieval_document_order' }),
      ]),
    )
  })

  it('uses a user-only replay target instead of falling back to the last assistant turn', () => {
    const seed = buildEvalSeedTurn(snapshot({
      sourceMessageId: null,
      replayTarget: { userMessageId: 'u2', assistantMessageId: null },
      messages: [
        message('u1', 'user'),
        message('a1', 'assistant'),
        message('u2', 'user'),
      ],
    }))

    expect(seed?.userTurn.id).toBe('u2')
    expect(seed?.assistantTurn).toBeNull()
  })

  it('uses an assistant replay target when the snapshot captured an assistant answer', () => {
    const seed = buildEvalSeedTurn(snapshot({
      sourceMessageId: 'a1',
      replayTarget: { userMessageId: 'u1', assistantMessageId: 'a1' },
      messages: [
        message('u1', 'user'),
        message('a1', 'assistant'),
        message('u2', 'user'),
      ],
    }))

    expect(seed?.userTurn.id).toBe('u1')
    expect(seed?.assistantTurn?.id).toBe('a1')
  })

  it('keeps the legacy sourceMessageId fallback for snapshots without a replay target', () => {
    const seed = buildEvalSeedTurn(snapshot({
      sourceMessageId: 'a1',
      replayTarget: null,
      messages: [
        message('u1', 'user'),
        message('a1', 'assistant'),
        message('u2', 'user'),
      ],
    }))

    expect(seed?.userTurn.id).toBe('u1')
    expect(seed?.assistantTurn?.id).toBe('a1')
  })
})
