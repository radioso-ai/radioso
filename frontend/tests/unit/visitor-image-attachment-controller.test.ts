import { describe, expect, it, vi } from 'vitest'

import { VisitorImageAttachments } from '@/lib/visitor-image-attachment-controller'
import { VISITOR_IMAGE_BUSY_RETRY_MS, hasUploadInFlight, readyImageIds } from '@/lib/visitor-image-attachments'
import type { ImageCodec } from '@/lib/visitor-image-downsize'

const photo = (name: string, size = 1_000, type = 'image/jpeg') => new File([new Uint8Array(size)], name, { type })

/** A codec that cannot decode, so every photo uploads as it is. */
const passThroughCodec: ImageCodec = { decode: async () => { throw new Error('no decoder in this test') } }

interface Upload {
  file: File
  signal: AbortSignal
  succeed(id: string): void
  fail(error: unknown): void
}

const setup = (options: { codec?: ImageCodec } = {}) => {
  const waits: number[] = []
  const uploads: Upload[] = []
  let keys = 0
  let urls = 0
  const revoked: string[] = []
  const upload = vi.fn((file: File, signal: AbortSignal) => new Promise<{ id: string }>((resolve, reject) => {
    uploads.push({ file, signal, succeed: (id) => resolve({ id }), fail: reject })
  }))
  const attachments = new VisitorImageAttachments({
    upload,
    codec: options.codec ?? passThroughCodec,
    previews: { create: () => `blob:preview-${urls += 1}`, revoke: (url) => { revoked.push(url) } },
    createKey: () => `key-${keys += 1}`,
    wait: async (ms) => { waits.push(ms) },
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { attachments, uploads, upload, revoked, settle, waits }
}

describe('attaching photos', () => {
  it('shows each photo as uploading with a preview, then ready with the id the server gave it', async () => {
    const { attachments, uploads, settle } = setup()

    attachments.addFiles([photo('a.jpg'), photo('b.jpg')])
    expect(attachments.getState().attachments.map((attachment) => [attachment.fileName, attachment.status, attachment.previewUrl]))
      .toEqual([['a.jpg', 'uploading', 'blob:preview-1'], ['b.jpg', 'uploading', 'blob:preview-2']])
    expect(hasUploadInFlight(attachments.getState())).toBe(true)

    await settle()
    expect(uploads).toHaveLength(2)
    uploads[1].succeed('image-b')
    uploads[0].succeed('image-a')
    await settle()

    expect(readyImageIds(attachments.getState())).toEqual(['image-a', 'image-b'])
    expect(hasUploadInFlight(attachments.getState())).toBe(false)
  })

  it('uploads the shrunk photo the downsizer produced, not the original', async () => {
    const shrunk = new Blob([new Uint8Array(200_000)], { type: 'image/jpeg' })
    const codec: ImageCodec = {
      decode: async () => ({ width: 4000, height: 3000, encodeJpeg: async () => shrunk, close: () => undefined }),
    }
    const { attachments, uploads, settle } = setup({ codec })

    attachments.addFiles([photo('IMG_1.png', 4_000_000, 'image/png')])
    await settle()

    expect(uploads[0].file.size).toBe(200_000)
    expect(uploads[0].file.type).toBe('image/jpeg')
    expect(uploads[0].file.name).toBe('IMG_1.jpg')
  })

  it('refuses a type the server would refuse without uploading it or previewing it', async () => {
    const { attachments, upload, settle } = setup()

    attachments.addFiles([photo('animation.gif', 500, 'image/gif')])
    await settle()

    expect(upload).not.toHaveBeenCalled()
    expect(attachments.getState().attachments[0]).toMatchObject({ status: 'error', failure: 'unsupported_type', previewUrl: null })
  })

  it('refuses a photo still over the 10 MiB cap once the browser could not shrink it', async () => {
    const { attachments, upload, settle } = setup()

    attachments.addFiles([photo('huge.jpg', 10 * 1024 * 1024 + 1)])
    await settle()

    expect(upload).not.toHaveBeenCalled()
    expect(attachments.getState().attachments[0]).toMatchObject({ status: 'error', failure: 'too_large' })
  })

  it('takes three photos at most and uploads only those', async () => {
    const { attachments, upload, settle } = setup()

    attachments.addFiles([photo('1.jpg'), photo('2.jpg'), photo('3.jpg'), photo('4.jpg')])
    await settle()

    expect(attachments.getState().attachments).toHaveLength(3)
    expect(attachments.getState().limitReached).toBe(true)
    expect(upload).toHaveBeenCalledTimes(3)
  })

  it('does not make a preview for a photo that did not fit', () => {
    const { attachments } = setup()
    attachments.addFiles([photo('1.jpg'), photo('2.jpg'), photo('3.jpg')])
    attachments.addFiles([photo('4.jpg')])

    expect(attachments.getState().attachments).toHaveLength(3)
    expect(attachments.getState().attachments.map((attachment) => attachment.previewUrl)).toEqual(['blob:preview-1', 'blob:preview-2', 'blob:preview-3'])
  })

  it('records why an upload failed', async () => {
    const { attachments, uploads, settle } = setup()
    attachments.addFiles([photo('a.jpg'), photo('b.jpg')])
    await settle()

    uploads[0].fail({ status: 413, error: { code: 'image_too_large', message: 'Too big' } })
    uploads[1].fail(new TypeError('Failed to fetch'))
    await settle()

    expect(attachments.getState().attachments.map((attachment) => attachment.status === 'error' && attachment.failure))
      .toEqual(['too_large', 'failed'])
  })
})

describe('a server too busy to take a photo', () => {
  const busy = { status: 503, error: { code: 'visitor_image_busy', message: 'Try again.' } }

  it('is tried once more after a short wait, and the photo is ready when that works', async () => {
    const { attachments, uploads, settle, waits } = setup()
    attachments.addFiles([photo('a.jpg')])
    await settle()

    uploads[0].fail(busy)
    await settle()
    expect(waits).toEqual([VISITOR_IMAGE_BUSY_RETRY_MS])
    expect(attachments.getState().attachments[0].status).toBe('uploading')
    expect(uploads).toHaveLength(2)
    expect(uploads[1].file).toBe(uploads[0].file)

    uploads[1].succeed('image-a')
    await settle()
    expect(readyImageIds(attachments.getState())).toEqual(['image-a'])
  })

  it('shows the error when the second try is busy too, and tries no third time', async () => {
    const { attachments, uploads, settle } = setup()
    attachments.addFiles([photo('a.jpg')])
    await settle()

    uploads[0].fail(busy)
    await settle()
    uploads[1].fail(busy)
    await settle()

    expect(uploads).toHaveLength(2)
    expect(attachments.getState().attachments[0]).toMatchObject({ status: 'error', failure: 'busy' })
  })

  it('does not try again for any other error', async () => {
    const { attachments, uploads, settle, waits } = setup()
    attachments.addFiles([photo('a.jpg')])
    await settle()

    uploads[0].fail({ status: 429, error: { code: 'usage_limit_exceeded', message: 'No.' } })
    await settle()

    expect(uploads).toHaveLength(1)
    expect(waits).toEqual([])
    expect(attachments.getState().attachments[0]).toMatchObject({ status: 'error', failure: 'unavailable' })
  })

  it('is not tried again when the visitor removed the photo while it waited', async () => {
    const { attachments, uploads, settle } = setup()
    attachments.addFiles([photo('a.jpg')])
    await settle()
    uploads[0].fail(busy)

    attachments.remove('key-1')
    await settle()

    expect(uploads).toHaveLength(1)
    expect(attachments.getState().attachments).toEqual([])
  })
})

describe('removing a photo', () => {
  it('stops its upload, releases its preview, and ignores the answer when it comes', async () => {
    const { attachments, uploads, revoked, settle } = setup()
    attachments.addFiles([photo('a.jpg')])
    await settle()

    attachments.remove('key-1')
    expect(uploads[0].signal.aborted).toBe(true)
    expect(revoked).toEqual(['blob:preview-1'])
    expect(attachments.getState().attachments).toEqual([])

    uploads[0].succeed('late-image')
    await settle()
    expect(attachments.getState().attachments).toEqual([])
  })

  it('lets a failed photo go, freeing its place', async () => {
    const { attachments, uploads, settle } = setup()
    attachments.addFiles([photo('a.jpg')])
    await settle()
    uploads[0].fail(new Error('boom'))
    await settle()

    attachments.remove('key-1')

    expect(attachments.getState().attachments).toEqual([])
  })
})

describe('sending', () => {
  it('hands over the uploaded photos and clears the composer, keeping nothing that was still going', async () => {
    const { attachments, uploads, revoked, settle } = setup()
    attachments.addFiles([photo('a.jpg'), photo('b.jpg')])
    await settle()
    uploads[0].succeed('image-a')
    await settle()

    expect(attachments.takeForSend()).toEqual(['image-a'])
    expect(attachments.getState().attachments).toEqual([])
    expect(revoked.sort()).toEqual(['blob:preview-1', 'blob:preview-2'])
    expect(uploads[1].signal.aborted).toBe(true)
  })
})

describe('a send the server refused for its photos', () => {
  it('leaves the composer empty with the reason shown', async () => {
    const { attachments, uploads, settle } = setup()
    attachments.addFiles([photo('a.jpg')])
    await settle()
    uploads[0].succeed('image-a')
    await settle()
    attachments.takeForSend()

    attachments.refuseSend('unavailable')

    expect(attachments.getState().attachments).toEqual([])
    expect(attachments.getState().sendFailure).toBe('unavailable')
  })
})

describe('starting a new chat', () => {
  it('drops every photo and releases its preview', async () => {
    const { attachments, revoked, settle } = setup()
    attachments.addFiles([photo('a.jpg')])
    await settle()

    attachments.clear()

    expect(attachments.getState().attachments).toEqual([])
    expect(revoked).toEqual(['blob:preview-1'])
  })
})

describe('leaving the chat', () => {
  it('stops every upload and releases every preview', async () => {
    const { attachments, uploads, revoked, settle } = setup()
    attachments.addFiles([photo('a.jpg'), photo('b.jpg')])
    await settle()

    attachments.dispose()

    expect(uploads.every((entry) => entry.signal.aborted)).toBe(true)
    expect(revoked.sort()).toEqual(['blob:preview-1', 'blob:preview-2'])
  })
})

describe('subscribers', () => {
  it('hear about every change, and stop hearing once they unsubscribe', async () => {
    const { attachments, settle } = setup()
    const listener = vi.fn()
    const unsubscribe = attachments.subscribe(listener)

    attachments.addFiles([photo('a.jpg')])
    expect(listener).toHaveBeenCalled()

    unsubscribe()
    listener.mockClear()
    await settle()
    attachments.remove('key-1')
    expect(listener).not.toHaveBeenCalled()
  })
})
