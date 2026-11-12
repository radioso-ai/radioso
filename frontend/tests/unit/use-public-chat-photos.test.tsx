/* @vitest-environment jsdom */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UnsentImageSend } from '@/lib/public-chat-errors'
import { usePublicChatPhotos } from '@/lib/use-public-chat-photos'

type Photos = ReturnType<typeof usePublicChatPhotos>
type SendMessage = Parameters<typeof usePublicChatPhotos>[0]['sendMessage']

const copy = { publicChatImageAlt: 'Photo you sent', publicChatImageUnavailableLabel: 'Photo unavailable' }

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0))
const settle = () => act(async () => { await flush() })

let objectUrls = 0
const revoked: string[] = []

beforeEach(() => {
  objectUrls = 0
  revoked.length = 0
  URL.createObjectURL = () => `blob:photo-${objectUrls += 1}`
  URL.revokeObjectURL = (url: string) => { revoked.push(url) }
})

const photoFile = (name: string) => new File([new Uint8Array(1_000)], name, { type: 'image/jpeg' })

interface Harness {
  photos: () => Photos
  input: () => string
  setAccepting: (accepts: boolean) => void
  type: (text: string) => void
  root: Root
  container: HTMLDivElement
}

const mount = (sendMessage: SendMessage, uploadImage = vi.fn(async (file: File) => ({ id: `image-${file.name}` }))): Harness => {
  const captured: { photos?: Photos; input: string; setAccepting?: (accepts: boolean) => void; setText?: (text: string) => void } = { input: '' }
  function Probe() {
    const [accepts, setAccepts] = useState(true)
    const [input, setInput] = useState('')
    captured.setAccepting = setAccepts
    captured.setText = setInput
    captured.input = input
    captured.photos = usePublicChatPhotos({ acceptsImages: accepts, uploadImage, sendMessage, publicChatToken: 'chat-token', copy, input, setInput })
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<Probe />)
  })
  return {
    photos: () => captured.photos!,
    input: () => captured.input,
    setAccepting: (accepts) => act(() => captured.setAccepting!(accepts)),
    type: (text) => act(() => captured.setText!(text)),
    root,
    container,
  }
}

const attachReady = async (harness: Harness, ...names: string[]) => {
  act(() => harness.photos().composerImages!.onFiles(names.map(photoFile)))
  await settle()
  await settle()
}

describe('photos that leave the composer with a send', () => {
  let harness: Harness | null = null
  afterEach(() => {
    if (harness) {
      act(() => harness?.root.unmount())
      harness.container.remove()
    }
    harness = null
  })

  const sending = (reaction: (options: { imageIds: string[]; onNotSent: (reason: UnsentImageSend) => void }) => void = () => undefined) => {
    const calls: Array<{ text: string; imageIds: string[] }> = []
    const sendMessage: SendMessage = async (text, _metadata, options) => {
      calls.push({ text, imageIds: options.imageIds })
      reaction(options)
    }
    return { calls, sendMessage }
  }

  it('lets the photos go for good when the server took the send, releasing their previews', async () => {
    const { calls, sendMessage } = sending()
    harness = mount(sendMessage)
    await attachReady(harness, 'a.jpg', 'b.jpg')
    harness.type('Something like this')
    expect(harness.photos().canSend).toBe(true)

    await act(async () => harness!.photos().send('Something like this'))

    expect(calls).toEqual([{ text: 'Something like this', imageIds: ['image-a.jpg', 'image-b.jpg'] }])
    expect(harness.photos().composerImages?.attachments).toEqual([])
    expect(harness.input()).toBe('')
    expect(revoked.sort()).toEqual(['blob:photo-1', 'blob:photo-2'])
  })

  it('gives the photos and the words back when the message did not go, still uploaded, so a second send needs no new upload', async () => {
    const attempts: Array<(options: { onNotSent: (reason: UnsentImageSend) => void }) => void> = [(options) => options.onNotSent('not_sent')]
    const { calls, sendMessage } = sending((options) => attempts.shift()?.(options))
    const uploadImage = vi.fn(async (file: File) => ({ id: `image-${file.name}` }))
    harness = mount(sendMessage, uploadImage)
    await attachReady(harness, 'a.jpg')
    harness.type('Something like this')

    await act(async () => harness!.photos().send('Something like this'))

    expect(harness.input()).toBe('Something like this')
    expect(harness.photos().composerImages?.attachments.map((attachment) => attachment.status)).toEqual(['ready'])
    expect(harness.photos().composerImages?.sendFailure).toBe('not_sent')
    expect(revoked).toEqual([])
    expect(harness.photos().canSend).toBe(true)

    await act(async () => harness!.photos().send('Something like this'))

    expect(calls.map((call) => call.imageIds)).toEqual([['image-a.jpg'], ['image-a.jpg']])
    expect(uploadImage).toHaveBeenCalledTimes(1)
  })

  it.each<UnsentImageSend>(['rate_limited', 'not_started'])('gives the photos and the words back, with no notice of its own, when the send was %s', async (reason) => {
    const { sendMessage } = sending((options) => options.onNotSent(reason))
    harness = mount(sendMessage)
    await attachReady(harness, 'a.jpg')
    harness.type('Words')

    await act(async () => harness!.photos().send('Words'))

    expect(harness.input()).toBe('Words')
    expect(harness.photos().composerImages?.attachments).toHaveLength(1)
    expect(harness.photos().composerImages?.sendFailure).toBeNull()
  })

  it('keeps what the visitor has typed since, rather than replacing it with the words that did not go', async () => {
    const { sendMessage } = sending((options) => {
      harness!.type('Typed while it was sending')
      options.onNotSent('not_sent')
    })
    harness = mount(sendMessage)
    await attachReady(harness, 'a.jpg')

    await act(async () => harness!.photos().send('Old words'))

    expect(harness.input()).toBe('Typed while it was sending')
  })

  it('lets the photos go, with the reason, when the server refused them, and puts the words back', async () => {
    const { sendMessage } = sending((options) => options.onNotSent('images_refused'))
    harness = mount(sendMessage)
    await attachReady(harness, 'a.jpg')
    harness.type('Words')

    await act(async () => harness!.photos().send('Words'))

    expect(harness.input()).toBe('Words')
    expect(harness.photos().composerImages?.attachments).toEqual([])
    expect(harness.photos().composerImages?.sendFailure).toBe('unavailable')
    expect(revoked).toEqual(['blob:photo-1'])
  })
})

describe('photos the chat stops offering', () => {
  let harness: Harness | null = null
  afterEach(() => {
    if (harness) {
      act(() => harness?.root.unmount())
      harness.container.remove()
    }
    harness = null
  })

  it('are dropped with a notice that outlives the controls, and neither count toward a send nor go with one', async () => {
    const calls: Array<{ text: string; imageIds: string[] }> = []
    harness = mount(async (text, _metadata, options) => { calls.push({ text, imageIds: options.imageIds }) })
    await attachReady(harness, 'a.jpg')
    expect(harness.photos().canSend).toBe(true)

    harness.setAccepting(false)
    await settle()

    expect(harness.photos().canSend).toBe(false)
    expect(harness.photos().composerImages).toMatchObject({ attachments: [], canAttach: false, sendFailure: 'unavailable' })
    expect(revoked).toEqual(['blob:photo-1'])

    harness.type('Words only')
    expect(harness.photos().canSend).toBe(true)
    await act(async () => harness!.photos().send('Words only'))

    expect(calls).toEqual([{ text: 'Words only', imageIds: [] }])
  })

  it('show no notice when the chat never took photos', async () => {
    harness = mount(async () => undefined)
    harness.setAccepting(false)
    await settle()

    expect(harness.photos().composerImages).toBeUndefined()
  })

  it('do not count while hidden, even for the instant before they are dropped', async () => {
    harness = mount(async () => undefined)
    await attachReady(harness, 'a.jpg')

    harness.setAccepting(false)

    expect(harness.photos().canSend).toBe(false)
  })
})

describe('a file dropped outside the composer', () => {
  let harness: Harness | null = null
  afterEach(() => {
    if (harness) {
      act(() => harness?.root.unmount())
      harness.container.remove()
    }
    harness = null
  })

  const dropFile = () => {
    const event = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown }
    event.dataTransfer = { types: ['Files'], files: [] }
    document.body.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('is not opened by the browser while the chat takes photos', async () => {
    harness = mount(async () => undefined)
    expect(dropFile()).toBe(true)
  })

  it('is left to the browser when the chat takes none', async () => {
    harness = mount(async () => undefined)
    harness.setAccepting(false)
    await settle()
    expect(dropFile()).toBe(false)
  })
})
