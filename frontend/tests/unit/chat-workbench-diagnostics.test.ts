import { describe, expect, it } from 'vitest'

import { buildLiveTurnDiagnostics, historyTurnToChatMessage } from '@/lib/chat-workbench-diagnostics'
import type { ChatMessage } from '@/lib/chat-context'
import type { ChatConversationTurn } from '@/lib/api-types'

const coverage = {
  availability: 'assessed' as const,
  coverage: 'unanswered' as const,
  reason: 'insufficient_evidence' as const,
  contextualizedRequest: 'Can I attend?',
  originatingTurnId: 'turn-1',
  originatingRequestId: 'request-1',
  schemaVersion: 1,
}
const interaction = { state: 'evaluated' as const, decisions: [] }

describe('chat workbench diagnostics mapping', () => {
  it('preserves coverage debug while adopting persisted history', () => {
    const adopted = historyTurnToChatMessage({
      id: 'assistant-1', role: 'assistant', content: 'I need more evidence.', createdAt: '2026-01-01T00:00:00.000Z',
      debug: { answerCoverage: coverage, interactionTrace: interaction },
    } as unknown as ChatConversationTurn)

    expect(adopted.answerCoverage).toEqual(coverage)
    expect(adopted.interactionTrace).toEqual(interaction)
  })

  it('projects coverage debug from a live assistant into selected-turn diagnostics', () => {
    const selected = { id: 'user-1', role: 'user', content: 'Can I attend?', createdAt: '', status: 'complete' } satisfies ChatMessage
    const assistant = {
      id: 'assistant-1', role: 'assistant', content: 'I need more evidence.', createdAt: '', status: 'complete',
      answerCoverage: coverage, interactionTrace: interaction,
    } satisfies ChatMessage

    expect(buildLiveTurnDiagnostics(selected, assistant)).toMatchObject({
      messageId: 'user-1', answerCoverage: coverage, interactionTrace: interaction,
    })
  })
})
