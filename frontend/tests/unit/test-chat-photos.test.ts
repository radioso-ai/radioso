import { describe, expect, it, vi } from 'vitest'

import {
  beginTestExecutionTurn,
  hydrateTestExecutionState,
  initializeTestExecutionState,
  pendingReadingImageIds,
  withStoredImageInputs,
} from '@/lib/agent-test-execution-state'
import type { TestExecutionHistoryDetail } from '@/lib/api-agent-revisions'
import { photoReadingLocale, readWithRetries, testChatPhotoAvailability, testChatPhotoSendOutcome } from '@/lib/test-chat-photos'

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
  it('shows a sent message with its photos and what was typed, its readings pending rather than unread', () => {
    const sent = beginTestExecutionTurn(single(), 'Like this', 'turn-1', 'attempt-1', ['image-1'])

    expect(sent.sides.left.messages.at(-2)).toMatchObject({
      role: 'user',
      content: 'Like this',
      imageInput: { typedText: 'Like this', images: [{ id: 'image-1', reading: null }] },
      readingsPending: true,
    })
  })

  it('names the photos whose readings are not back yet, and none once the stored readings arrive', () => {
    const sent = beginTestExecutionTurn(single(), 'Like this', 'turn-1', 'attempt-1', ['image-1'])

    expect([...pendingReadingImageIds(sent.sides.left)]).toEqual(['image-1'])
    expect([...pendingReadingImageIds(withStoredImageInputs(sent, stored({ typedText: 'Like this', images: [{ id: 'image-1', reading } ] })).sides.left)]).toEqual([])
    expect([...pendingReadingImageIds(undefined)]).toEqual([])
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
    expect(read.sides.left.messages.at(-2)).not.toHaveProperty('readingsPending')
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

  it('says the same of a send without photos, so its words come back too', () => {
    expect(testChatPhotoSendOutcome({ taken: false, error: new TypeError('Failed to fetch') })).toEqual({ kind: 'returned', failure: 'not_sent' })
    expect(testChatPhotoSendOutcome({ taken: false, error: { error: { code: 'usage_limit_exceeded', message: 'over plan' } } })).toEqual({ kind: 'taken' })
  })

  it('gives them back to the composer when the message never reached the test', () => {
    expect(testChatPhotoSendOutcome({ taken: false, error: new TypeError('Failed to fetch') })).toEqual({ kind: 'returned', failure: 'not_sent' })
    expect(testChatPhotoSendOutcome({ taken: false, error: { error: { code: 'test_turn_in_progress', message: 'busy' } } })).toEqual({ kind: 'returned', failure: 'not_sent' })
  })
})

describe('the language a Test Chat photo is read in', () => {
  it("is the operator's browser language, as a visitor's photo is read in the visitor's", () => {
    expect(photoReadingLocale('it-IT')).toBe('it-IT')
    expect(photoReadingLocale(' de ')).toBe('de')
  })

  it("is left to the agent's default when the browser names no usable language", () => {
    expect(photoReadingLocale(undefined)).toBeUndefined()
    expect(photoReadingLocale('')).toBeUndefined()
    expect(photoReadingLocale('not a language tag at all')).toBeUndefined()
  })
})

describe('reading the stored readings back', () => {
  it('tries again after a failed read, and settles on the first answer', async () => {
    const read = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('stored')
    const waits: number[] = []

    await expect(readWithRetries(read, [10, 20], async (ms) => { waits.push(ms) })).resolves.toBe('stored')

    expect(read).toHaveBeenCalledTimes(2)
    expect(waits).toEqual([10])
  })

  it('gives up quietly after its last try, so the photos stay pending rather than claim anything', async () => {
    const read = vi.fn(async () => { throw new Error('offline') })

    await expect(readWithRetries(read, [10, 20], async () => undefined)).resolves.toBeNull()

    expect(read).toHaveBeenCalledTimes(3)
  })
})
