import { describe, expect, it } from 'vitest'

import { beginTestExecutionTurn, initializeTestExecutionState } from '@/lib/agent-test-execution-state'
import { itemPickMessage, replyPicks } from '@/lib/reply-blocks'
import { testChatMessageBody, testChatPickOf } from '@/lib/test-chat-item-pick'
import { testChatThreadMessages } from '@/components/dashboard/test-chat-thread-messages'

const revision = (id: string) => ({ id, label: id, kind: 'candidate' as const, versionNumber: null, createdAt: '' })

const compare = () => initializeTestExecutionState({
  id: 'execution-1',
  generation: 2,
  mode: 'compare',
  skillEffects: 'suppressed',
  sides: [
    { id: 'left', revision: revision('a'), conversationId: 'left-chat', state: 'completed', retryable: false },
    { id: 'right', revision: revision('b'), conversationId: 'right-chat', state: 'completed', retryable: false },
  ],
})

const selection = { messageId: 'answer-left-1', blockId: 'b1', itemKey: '122' }
const card = { key: '122', title: 'Phone Two', actions: [{ type: 'select' as const }] }
const turn = { executionGeneration: 2, turnId: 'turn-2', attemptId: 'attempt-2' }

describe('a card picked in Test Chat', () => {
  it('is sent as the card\'s words with the card it names, as the thread\'s Select sends it', () => {
    const pick = testChatPickOf(...itemPickMessage(selection, card))

    expect(pick).toEqual({ message: 'Phone Two', selection })
    expect(testChatMessageBody({ text: 'ignored draft', imageIds: ['image-1'], pick, ...turn }))
      .toEqual({ message: 'Phone Two', selection, ...turn })
  })

  it('is no pick for anything else the thread sends', () => {
    expect(testChatPickOf('Phone Two', { method: 'typed' })).toBeNull()
    expect(testChatPickOf('  ', { method: 'item_select', selection })).toBeNull()
  })

  it('sends a typed message with its photos and no pick', () => {
    expect(testChatMessageBody({ text: 'Like this', imageIds: ['image-1'], pick: null, ...turn }))
      .toEqual({ message: 'Like this', imageIds: ['image-1'], ...turn })
    expect(testChatMessageBody({ text: '', imageIds: ['image-1'], pick: null, ...turn }))
      .toEqual({ imageIds: ['image-1'], ...turn })
  })

  it('settles the reply it was picked from at once, on the side whose reply showed the card', () => {
    const sent = beginTestExecutionTurn(compare(), 'Phone Two', 'turn-2', 'attempt-2', [], selection)

    for (const side of Object.values(sent.sides)) {
      const messages = testChatThreadMessages(side)
      expect(messages.at(-2)).toMatchObject({ role: 'user', content: 'Phone Two', inputMetadata: { method: 'item_select', selection } })
      expect(replyPicks(messages).get(selection.messageId)).toEqual({ blockId: 'b1', itemKey: '122' })
    }
  })
})
