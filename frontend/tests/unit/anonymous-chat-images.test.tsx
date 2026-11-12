/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnonymousChatProvider, useAnonymousChat } from '@/lib/anonymous-chat-context'
import { publicChatApi } from '@/lib/api'
import { clearVisitorImageCache, loadVisitorImage, visitorImageCacheKey } from '@/lib/visitor-image-blob-cache'

vi.mock('@/lib/api', () => ({
  clearStoredAnonymousSession: vi.fn(),
  publicChatApi: {
    bootstrapConversation: vi.fn(),
    createSession: vi.fn(),
    getConversationDetail: vi.fn(),
    listConversations: vi.fn(),
    streamConversationEvents: vi.fn(),
    streamMessage: vi.fn(),
    tailConversation: vi.fn(),
    uploadImage: vi.fn(),
  },
  readStoredAnonymousSessionId: vi.fn(() => null),
  readStoredEffectivePublicChatToken: vi.fn(() => null),
  readStoredPublicSessionResumeToken: vi.fn(() => null),
  readStoredPublicSessionToken: vi.fn(() => 'public-session-token'),
}))

const api = vi.mocked(publicChatApi)

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const IMAGE_ID = '6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12'

const emptyConversationList = {
  workspaceName: 'Acme',
  assistantAvatarUrl: null,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  theme: { brand: '#0f172a', brandText: '#f8fafc', surface: '#ffffff', text: '#0f172a' },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null },
  intakeActions: [],
  assistantBootstrapActive: false,
  conversations: [],
  total: 0,
  nextCursor: null,
  hasMore: false,
}

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0))

const waitFor = async (assertion: () => void) => {
  let lastError: unknown
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await act(async () => {
        await flush()
      })
    }
  }
  throw lastError
}

type Chat = ReturnType<typeof useAnonymousChat>

const mount = (onChat: (chat: Chat) => void) => {
  function Probe() {
    onChat(useAnonymousChat())
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <AnonymousChatProvider token="public-chat-token" sessionChannel={null} localeOverride="it">
        <Probe />
      </AnonymousChatProvider>,
    )
  })
  return { container, root }
}

describe('anonymous chat with photos', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null
  let chat: Chat

  const ready = async () => {
    mounted = mount((next) => {
      chat = next
    })
    await waitFor(() => expect(chat?.isHydrating).toBe(false))
  }

  beforeEach(() => {
    mounted = null
    clearVisitorImageCache()
    api.listConversations.mockResolvedValue(emptyConversationList)
    api.streamConversationEvents.mockImplementation(() => new Promise<void>(() => {}))
    api.tailConversation.mockResolvedValue({ messages: [], cursor: null })
    api.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      const completion = { conversationId: 'conversation-1', assistantMessageId: 'assistant-1', answer: 'Three farmhouses.', citations: [], answerSegments: [], suggestions: [] }
      handlers?.onConversation?.({ conversationId: completion.conversationId })
      handlers?.onDone?.(completion)
      return completion
    })
  })

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted?.root.unmount()
      })
      mounted.container.remove()
    }
    vi.clearAllMocks()
  })

  it('offers photos when the conversation list a reload reads says the agent takes them, and not otherwise', async () => {
    await ready()
    expect(chat.acceptsImages).toBe(false)

    act(() => mounted?.root.unmount())
    mounted = null
    api.listConversations.mockResolvedValue({ ...emptyConversationList, acceptsImages: true })
    await ready()
    expect(chat.acceptsImages).toBe(true)
  })

  it('sends photos with no text, and shows the visitor message as its photos', async () => {
    await ready()

    await act(async () => {
      await chat.sendMessage('', { method: 'typed' }, { imageIds: [IMAGE_ID] })
    })

    expect(api.streamMessage).toHaveBeenCalledTimes(1)
    const body = api.streamMessage.mock.calls[0][1]
    expect(body.imageIds).toEqual([IMAGE_ID])
    expect(body).not.toHaveProperty('message', '')
    expect(body.message).toBeUndefined()
    // The request carries the visitor's own metadata; the record of the photos is for their thread only.
    expect(body.inputMetadata).toEqual({ method: 'typed' })

    const sent = chat.messages.find((message) => message.role === 'user')
    expect(sent?.inputMetadata?.imageInput).toEqual({ typedText: '', images: [{ id: IMAGE_ID, reading: null }] })
  })

  it('sends the typed text with the photos', async () => {
    await ready()

    await act(async () => {
      await chat.sendMessage('  Something like this  ', { method: 'typed' }, { imageIds: [IMAGE_ID] })
    })

    expect(api.streamMessage.mock.calls[0][1]).toMatchObject({ message: 'Something like this', imageIds: [IMAGE_ID] })
    const sent = chat.messages.find((message) => message.role === 'user')
    expect(sent?.content).toBe('Something like this')
    expect(sent?.inputMetadata?.imageInput?.typedText).toBe('Something like this')
  })

  it('does not send a message with neither text nor photos, and sends text alone as before', async () => {
    await ready()

    await act(async () => {
      await chat.sendMessage('   ', { method: 'typed' }, { imageIds: [] })
      await chat.sendMessage('', { method: 'typed' })
    })
    expect(api.streamMessage).not.toHaveBeenCalled()

    await act(async () => {
      await chat.sendMessage('When do you open?', { method: 'typed' })
    })
    const body = api.streamMessage.mock.calls[0][1]
    expect(body.message).toBe('When do you open?')
    expect(body).not.toHaveProperty('imageIds')
    expect(chat.messages.find((message) => message.role === 'user')?.inputMetadata).toEqual({ method: 'typed' })
  })

  it("uploads a photo for the visitor's session in their language, and keeps it for the thumbnail", async () => {
    api.uploadImage.mockResolvedValue({ id: IMAGE_ID, readingStatus: 'read' })
    await ready()
    const photo = new File([new Uint8Array([1, 2, 3])], 'farmhouse.jpg', { type: 'image/jpeg' })
    const signal = new AbortController().signal

    const uploaded = await chat.uploadImage(photo, signal)

    expect(uploaded).toEqual({ id: IMAGE_ID, readingStatus: 'read' })
    expect(api.uploadImage).toHaveBeenCalledWith('public-chat-token', photo, { locale: 'it', signal })
    const fetchBlob = vi.fn(async () => new Blob(['from the server']))
    await expect(loadVisitorImage(visitorImageCacheKey('public-chat-token', IMAGE_ID), fetchBlob)).resolves.toBe(photo)
    expect(fetchBlob).not.toHaveBeenCalled()
  })

  it('stops offering photos once the agent refuses an upload', async () => {
    api.listConversations.mockResolvedValue({ ...emptyConversationList, acceptsImages: true })
    api.uploadImage.mockRejectedValue({ status: 404, error: { code: 'visitor_images_unavailable', message: 'No.' } })
    await ready()
    expect(chat.acceptsImages).toBe(true)

    await act(async () => {
      await expect(chat.uploadImage(new File([new Uint8Array([1])], 'a.jpg'), new AbortController().signal)).rejects.toMatchObject({
        error: { code: 'visitor_images_unavailable' },
      })
    })

    await waitFor(() => expect(chat.acceptsImages).toBe(false))
  })

  describe('when a send with photos fails before the server takes them', () => {
    const refusal = { status: 409, error: { code: 'visitor_image_unavailable', message: 'Not available.' } }

    const sendWithPhotos = async (options: { onNotSent: (reason: string) => void }) => {
      await act(async () => {
        await chat.sendMessage('Something like this', { method: 'typed' }, { imageIds: [IMAGE_ID], ...options })
      })
    }

    it('takes the turn out of the thread when the server refuses the photos, stops offering photos, and tells the caller', async () => {
      api.listConversations.mockResolvedValue({ ...emptyConversationList, acceptsImages: true })
      api.streamMessage.mockRejectedValue(refusal)
      await ready()
      expect(chat.acceptsImages).toBe(true)
      const onNotSent = vi.fn()

      await sendWithPhotos({ onNotSent })

      expect(onNotSent).toHaveBeenCalledExactlyOnceWith('images_refused')
      expect(chat.messages).toEqual([])
      expect(chat.isLoading).toBe(false)
      expect(chat.rateLimitError).toBeNull()
      expect(chat.acceptsImages).toBe(false)
    })

    it('takes the turn out of the thread and tells the caller when the request never got an answer', async () => {
      api.streamMessage.mockRejectedValue(new TypeError('Failed to fetch'))
      await ready()
      const onNotSent = vi.fn()

      await sendWithPhotos({ onNotSent })

      expect(onNotSent).toHaveBeenCalledExactlyOnceWith('not_sent')
      expect(chat.messages).toEqual([])
      expect(chat.isLoading).toBe(false)
    })

    it('tells the caller when the request was held back by a rate limit, and shows the wait', async () => {
      api.streamMessage.mockRejectedValue({ status: 429, error: { code: 'rate_limit_exceeded', message: 'Slow down.', retryAfterSeconds: 30 } })
      await ready()
      const onNotSent = vi.fn()

      await sendWithPhotos({ onNotSent })

      expect(onNotSent).toHaveBeenCalledExactlyOnceWith('rate_limited')
      expect(chat.messages).toEqual([])
      expect(chat.retryAfterSeconds).toBe(30)
    })

    it('tells the caller when it never started because another send was still going, and runs only the first', async () => {
      api.streamMessage.mockImplementation(() => new Promise(() => {}))
      await ready()
      const onNotSent = vi.fn()

      await act(async () => {
        void chat.sendMessage('First', { method: 'typed' })
        await chat.sendMessage('Second', { method: 'typed' }, { imageIds: [IMAGE_ID], onNotSent })
      })

      expect(onNotSent).toHaveBeenCalledExactlyOnceWith('not_started')
      expect(api.streamMessage).toHaveBeenCalledTimes(1)
    })

    it('does not give the photos back once the reply has started, since the server has them', async () => {
      api.streamMessage.mockImplementation(async (_token, _data, handlers) => {
        handlers?.onConversation?.({ conversationId: 'conversation-1' })
        throw new TypeError('network error while streaming')
      })
      await ready()
      const onNotSent = vi.fn()

      await sendWithPhotos({ onNotSent })

      expect(onNotSent).not.toHaveBeenCalled()
      expect(chat.messages.find((message) => message.role === 'user')).toBeTruthy()
    })

    it('does not give the photos back when the plan has no answers left, which refuses a turn that stored them', async () => {
      api.streamMessage.mockRejectedValue({ status: 429, error: { code: 'usage_limit_exceeded', message: 'No answers left.' } })
      await ready()
      const onNotSent = vi.fn()

      await sendWithPhotos({ onNotSent })

      expect(onNotSent).not.toHaveBeenCalled()
      expect(chat.messages.find((message) => message.role === 'assistant')?.failure).toBe('unavailable')
    })

    it('treats the same failures of a message with no photos as the failures they are', async () => {
      api.streamMessage.mockRejectedValue(refusal)
      await ready()
      const onNotSent = vi.fn()

      await act(async () => {
        await chat.sendMessage('Hello', { method: 'typed' }, { onNotSent })
      })

      expect(onNotSent).not.toHaveBeenCalled()
      expect(chat.messages.find((message) => message.role === 'assistant')?.status).toBe('error')
    })
  })
})
