import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api-client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api-client')>()),
  attachAnonymousSessionHeader: (_token: string, headers: Record<string, string>) => ({
    ...headers,
    'X-Radioso-Public-Session': 'public-session-token',
  }),
  persistAnonymousSessionHeader: () => undefined,
}))

import { publicChatApi } from '@/lib/api-public-chat'
import type { ChatStreamCompletion, ReplyBlock } from '@/lib/api-types'

const IMAGE_ID = '6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12'

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const requestOf = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }]

describe('uploading a visitor photo', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the photo as the multipart field image, with the visitor session and language', async () => {
    const fetchMock = vi.fn(async () => respond(201, { id: IMAGE_ID, readingStatus: 'read' }))
    vi.stubGlobal('fetch', fetchMock)
    const photo = new File([new Uint8Array([1, 2, 3])], 'farmhouse.jpg', { type: 'image/jpeg' })

    const result = await publicChatApi.uploadImage('chat-token', photo, { locale: 'it' })

    expect(result).toEqual({ id: IMAGE_ID, readingStatus: 'read' })
    const [url, init] = requestOf(fetchMock)
    expect(url).toBe('/backend/api/v1/public/chat/chat-token/images')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'X-Radioso-Public-Session': 'public-session-token' })
    expect(init.headers).not.toHaveProperty('Content-Type')
    const form = init.body as FormData
    expect((form.get('image') as File).name).toBe('farmhouse.jpg')
    expect(form.get('locale')).toBe('it')
  })

  it('sends no locale when the visitor names none', async () => {
    const fetchMock = vi.fn(async () => respond(201, { id: IMAGE_ID, readingStatus: 'unread' }))
    vi.stubGlobal('fetch', fetchMock)

    await publicChatApi.uploadImage('chat-token', new Blob([new Uint8Array([1])], { type: 'image/png' }))

    const form = requestOf(fetchMock)[1].body as FormData
    expect(form.has('locale')).toBe(false)
    expect((form.get('image') as File).name).toBe('photo.jpg')
  })

  it.each([
    [415, 'unsupported_image_type'],
    [413, 'image_too_large'],
    [404, 'visitor_images_unavailable'],
    [429, 'rate_limit_exceeded'],
  ])('rejects with the API error for a %i answer', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(status, { error: { code, message: 'No.' } })))

    await expect(publicChatApi.uploadImage('chat-token', new Blob([new Uint8Array([1])]))).rejects.toMatchObject({
      status,
      error: { code },
    })
  })
})

describe('reading a visitor photo back', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches the bytes with the visitor session header, for the caller to show as a blob', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([255, 216, 255]), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetchMock)

    const blob = await publicChatApi.fetchImage('chat-token', IMAGE_ID)

    expect(blob.size).toBe(3)
    const [url, init] = requestOf(fetchMock)
    expect(url).toBe(`/backend/api/v1/public/chat/chat-token/images/${IMAGE_ID}`)
    expect(init.method).toBe('GET')
    expect(init.headers).toMatchObject({ 'X-Radioso-Public-Session': 'public-session-token' })
  })

  it('rejects when the photo is not the session\'s to read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(404, { error: { code: 'not_found', message: 'Image not found' } })))

    await expect(publicChatApi.fetchImage('chat-token', IMAGE_ID)).rejects.toMatchObject({ status: 404 })
  })
})

describe('a reply the server sends whole instead of as a stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hands the reply blocks over with the completion', async () => {
    const block: ReplyBlock = {
      type: 'item_list',
      id: 'block-1',
      layout: 'grid',
      selection: 'none',
      caption: 'Rooms at the guest house',
      items: [{
        key: 'image-1',
        title: 'Garden room',
        image: { src: 'https://app.example/backend/api/v1/public/reply-images/image-1/640', alt: 'A bright room opening onto the garden', width: 640, height: 480 },
        actions: [],
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async () =>
      respond(200, { conversationId: 'conversation-1', assistantMessageId: 'assistant-1', answer: 'Here are the rooms.', blocks: [block] })))
    let donePayload: ChatStreamCompletion | undefined

    await publicChatApi.streamMessage('chat-token', { message: 'What do the rooms look like?', stream: true }, {
      onDone: (payload) => {
        donePayload = payload
      },
    })

    expect(donePayload).toMatchObject({ conversationId: 'conversation-1', answer: 'Here are the rooms.', blocks: [block] })
  })
})
