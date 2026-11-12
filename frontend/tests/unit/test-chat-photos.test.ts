import { describe, expect, it } from 'vitest'

import {
  beginTestExecutionTurn,
  hydrateTestExecutionState,
  initializeTestExecutionState,
  withStoredImageInputs,
} from '@/lib/agent-test-execution-state'
import type { TestExecutionHistoryDetail } from '@/lib/api-agent-revisions'
import { testChatPhotoAvailability, testChatPhotoSendOutcome } from '@/lib/test-chat-photos'

const revision = { id: 'revision-8', label: 'Draft', kind: 'candidate' as const, versionNumber: null, createdAt: '' }

const single = () => initializeTestExecutionState({
  id: 'execution-1',
  generation: 2,
  mode: 'single',
  skillEffects: 'suppressed',
  sides: [{ id: 'left', revision, conversationId: 'left-chat', state: 'completed', retryable: false }],
})

const reading = 'A stone farmhouse with a terracotta roof.'

const stored = (imageInput: { typedText: string; images: Array<{ id: string; reading: string | null }> }): TestExecutionHistoryDetail => ({
  id: 'execution-1', generation: 2, mode: 'single', skillEffects: 'suppressed', state: 'completed', createdAt: '', testValues: [], seededTurnCount: 0,
  sides: [{
    id: 'left', revision, conversationId: 'left-chat', state: 'completed', retryable: false,
    history: [
      { turnId: 'turn-1', role: 'user', content: `Like this\n<attached_photo index="1">${reading}</attached_photo>`, attemptId: 'attempt-1', createdAt: '', imageInput },
      { turnId: 'turn-1', role: 'assistant', content: 'Here are three.', messageId: 'message-1', attemptId: 'attempt-1', createdAt: '' },
    ],
  }],
  attempts: [],
})

describe('Test Chat photos in the transcript', () => {
  it('shows a sent message with its photos and what was typed while the agent reads them', () => {
    const sent = beginTestExecutionTurn(single(), 'Like this', 'turn-1', 'attempt-1', ['image-1'])

    expect(sent.sides.left.messages.at(-2)).toMatchObject({
      role: 'user',
      content: 'Like this',
      imageInput: { typedText: 'Like this', images: [{ id: 'image-1', reading: null }] },
    })
  })

  it('leaves a message without photos as text', () => {
    const sent = beginTestExecutionTurn(single(), 'Hello', 'turn-1', 'attempt-1')

    expect(sent.sides.left.messages.at(-2)).not.toHaveProperty('imageInput')
  })

  it('takes the readings the test stored for the turn, and nothing for other messages', () => {
    const sent = beginTestExecutionTurn(single(), 'Like this', 'turn-1', 'attempt-1', ['image-1'])
    const imageInput = { typedText: 'Like this', images: [{ id: 'image-1', reading }] }

    const read = withStoredImageInputs(sent, stored(imageInput))

    expect(read.sides.left.messages.at(-2)?.imageInput).toEqual(imageInput)
    expect(read.sides.left.messages.at(-1)).toEqual(sent.sides.left.messages.at(-1))
    expect(withStoredImageInputs(sent, { ...stored(imageInput), id: 'execution-2' })).toBe(sent)
  })

  it('reopens a test with each message showing its typed words and photos, never the readings in its text', () => {
    const imageInput = { typedText: 'Like this', images: [{ id: 'image-1', reading }] }

    const reopened = hydrateTestExecutionState(stored(imageInput))

    expect(reopened.sides.left.messages[0]).toMatchObject({ role: 'user', imageInput })
    expect(reopened.sides.left.messages[1]).not.toHaveProperty('imageInput')
  })
})

describe('whether Test Chat offers photos', () => {
  it('offers them exactly when the agent takes photos from visitors', () => {
    expect(testChatPhotoAvailability({ visitorImagesEnabled: true, chatModelReadsImages: true })).toBe('available')
    expect(testChatPhotoAvailability({ visitorImagesEnabled: false, chatModelReadsImages: true })).toBe('off')
    expect(testChatPhotoAvailability({ visitorImagesEnabled: undefined, chatModelReadsImages: true })).toBe('off')
    expect(testChatPhotoAvailability({ visitorImagesEnabled: true, chatModelReadsImages: false })).toBe('model_cannot_read')
    expect(testChatPhotoAvailability({ visitorImagesEnabled: true, chatModelReadsImages: undefined })).toBe('off')
  })
})

describe('what happens to the photos of a send', () => {
  it('lets them go once the test took the message', () => {
    expect(testChatPhotoSendOutcome({ taken: true })).toEqual({ kind: 'taken' })
  })

  it('drops them with a reason when the test refused them', () => {
    expect(testChatPhotoSendOutcome({ taken: false, error: { error: { code: 'visitor_image_unavailable', message: 'unavailable' } } })).toEqual({ kind: 'refused' })
  })

  it('gives them back to the composer when the message never reached the test', () => {
    expect(testChatPhotoSendOutcome({ taken: false, error: new TypeError('Failed to fetch') })).toEqual({ kind: 'returned', failure: 'not_sent' })
    expect(testChatPhotoSendOutcome({ taken: false, error: { error: { code: 'test_turn_in_progress', message: 'busy' } } })).toEqual({ kind: 'returned', failure: 'not_sent' })
  })
})
