import { describe, expect, it, vi } from 'vitest'

import { VisitorImageAttachments } from '@/lib/visitor-image-attachment-controller'
import { VISITOR_IMAGE_BUSY_RETRY_MS, hasUploadInFlight, readyImageIds } from '@/lib/visitor-image-attachments'
import type { DecodedImage, ImageCodec } from '@/lib/visitor-image-downsize'

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
  const previewed: Blob[] = []
  let keys = 0
  let urls = 0
  const revoked: string[] = []
  const upload = vi.fn((file: File, signal: AbortSignal) => new Promise<{ id: string }>((resolve, reject) => {
    uploads.push({ file, signal, succeed: (id) => resolve({ id }), fail: reject })
  }))
  const attachments = new VisitorImageAttachments({
    upload,
    codec: options.codec ?? passThroughCodec,
    previews: { create: (blob) => { previewed.push(blob); return `blob:preview-${urls += 1}` }, revoke: (url) => { revoked.push(url) } },
    createKey: () => `key-${keys += 1}`,
    wait: async (ms) => { waits.push(ms) },
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const uploaded = async (names: string[]) => {
    attachments.addFiles(names.map((name) => photo(name)))
    await settle()
    uploads.forEach((entry, index) => entry.succeed(`image-${names[index]}`))
    await settle()
  }
  return { attachments, uploads, upload, revoked, previewed, settle, waits, uploaded }
}

/** A codec whose decodes wait for the test, so it can see how many run at once. */
const slowCodec = () => {
  const started: Array<{ finish(): void }> = []
  let running = 0
  let mostAtOnce = 0
  const codec: ImageCodec = {
    decode: () => new Promise<DecodedImage>((resolve) => {
      running += 1
      mostAtOnce = Math.max(mostAtOnce, running)
      started.push({
        finish: () => {
          running -= 1
          resolve({ width: 800, height: 600, encodeJpeg: async () => new Blob([new Uint8Array(10)], { type: 'image/jpeg' }), close: () => undefined })
        },
      })
    }),
  }
  return { codec, started, mostAtOnce: () => mostAtOnce }
}

describe('attaching photos', () => {
  it('shows each photo as uploading, previews it once it is shrunk, and marks it ready with the id the server gave it', async () => {
    const { attachments, uploads, settle } = setup()

    attachments.addFiles([photo('a.jpg'), photo('b.jpg')])
    expect(attachments.getState().attachments.map((attachment) => [attachment.fileName, attachment.status, attachment.previewUrl]))
      .toEqual([['a.jpg', 'uploading', null], ['b.jpg', 'uploading', null]])
    expect(hasUploadInFlight(attachments.getState())).toBe(true)

    await settle()
    expect(attachments.getState().attachments.map((attachment) => attachment.previewUrl)).toEqual(['blob:preview-1', 'blob:preview-2'])
    expect(uploads).toHaveLength(2)
    uploads[1].succeed('image-b')
    uploads[0].succeed('image-a')
    await settle()

    expect(readyImageIds(attachments.getState())).toEqual(['image-a', 'image-b'])
    expect(hasUploadInFlight(attachments.getState())).toBe(false)
  })

  it('uploads the shrunk photo the downsizer produced, and previews that one rather than the original', async () => {
    const shrunk = new Blob([new Uint8Array(200_000)], { type: 'image/jpeg' })
    const codec: ImageCodec = {
      decode: async () => ({ width: 4000, height: 3000, encodeJpeg: async () => shrunk, close: () => undefined }),
    }
    const { attachments, uploads, previewed, settle } = setup({ codec })

    attachments.addFiles([photo('IMG_1.png', 4_000_000, 'image/png')])
    await settle()

    expect(uploads[0].file.size).toBe(200_000)
    expect(uploads[0].file.type).toBe('image/jpeg')
    expect(uploads[0].file.name).toBe('IMG_1.jpg')
    expect(previewed.map((blob) => blob.size)).toEqual([200_000])
  })

  it('refuses a type the server would refuse without uploading it or previewing it', async () => {
    const { attachments, upload, previewed, settle } = setup()

    attachments.addFiles([photo('animation.gif', 500, 'image/gif')])
    await settle()

    expect(upload).not.toHaveBeenCalled()
    expect(previewed).toEqual([])
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

  it('makes no preview for a photo that did not fit', async () => {
    const { attachments, previewed, settle } = setup()
    attachments.addFiles([photo('1.jpg'), photo('2.jpg'), photo('3.jpg')])
    attachments.addFiles([photo('4.jpg')])
    await settle()

    expect(attachments.getState().attachments).toHaveLength(3)
    expect(previewed).toHaveLength(3)
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

describe('shrinking several photos', () => {
  it('decodes one photo at a time, so a phone does not hold them all at full size at once', async () => {
    const { codec, started, mostAtOnce } = slowCodec()
    const { attachments, uploads, settle } = setup({ codec })
    const bigPhoto = (name: string) => photo(name, 4_000_000, 'image/png')

    attachments.addFiles([bigPhoto('a.png'), bigPhoto('b.png'), bigPhoto('c.png')])
    await settle()
    expect(started).toHaveLength(1)

    started[0].finish()
    await settle()
    // The first photo is on its way while the second is decoded.
    expect(uploads).toHaveLength(1)
    expect(started).toHaveLength(2)

    started[1].finish()
    await settle()
    started[2].finish()
    await settle()

    expect(uploads).toHaveLength(3)
    expect(mostAtOnce()).toBe(1)
  })

  it('never decodes a photo that was removed while it waited its turn', async () => {
    const { codec, started } = slowCodec()
    const { attachments, upload, settle } = setup({ codec })
    attachments.addFiles([photo('a.png', 4_000_000, 'image/png'), photo('b.png', 4_000_000, 'image/png')])
    await settle()

    attachments.remove('key-2')
    started[0].finish()
    await settle()

    expect(started).toHaveLength(1)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(attachments.getState().attachments.map((attachment) => attachment.key)).toEqual(['key-1'])
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
  it('hands over the uploaded photos and empties the composer, keeping their previews until the send is settled', async () => {
    const { attachments, revoked, uploaded } = setup()
    await uploaded(['a.jpg', 'b.jpg'])

    expect(attachments.takeForSend()).toEqual(['image-a.jpg', 'image-b.jpg'])
    expect(attachments.getState().attachments).toEqual([])
    expect(revoked).toEqual([])

    attachments.finishSend()
    expect(revoked.sort()).toEqual(['blob:preview-1', 'blob:preview-2'])
  })

  it('lets go of a failed photo when the message goes, since it has nothing to send', async () => {
    const { attachments, uploads, revoked, settle } = setup()
    attachments.addFiles([photo('a.jpg'), photo('b.jpg')])
    await settle()
    uploads[0].succeed('image-a')
    uploads[1].fail(new Error('boom'))
    await settle()

    expect(attachments.takeForSend()).toEqual(['image-a'])

    expect(revoked).toEqual(['blob:preview-2'])
  })

  it('puts the photos back, still uploaded and still previewed, when the server did not take them', async () => {
    const { attachments, revoked, uploaded } = setup()
    await uploaded(['a.jpg', 'b.jpg'])
    attachments.takeForSend()

    attachments.restoreSend('not_sent')

    expect(readyImageIds(attachments.getState())).toEqual(['image-a.jpg', 'image-b.jpg'])
    expect(attachments.getState().attachments.map((attachment) => attachment.previewUrl)).toEqual(['blob:preview-1', 'blob:preview-2'])
    expect(attachments.getState().sendFailure).toBe('not_sent')
    expect(revoked).toEqual([])
    // Sent a second time, they are the same photos.
    expect(attachments.takeForSend()).toEqual(['image-a.jpg', 'image-b.jpg'])
  })

  it('lets go of the photos a send took when the server refused them, and says why', async () => {
    const { attachments, revoked, uploaded } = setup()
    await uploaded(['a.jpg'])
    attachments.takeForSend()

    attachments.finishSend()
    attachments.notice('unavailable')

    expect(attachments.getState().attachments).toEqual([])
    expect(attachments.getState().sendFailure).toBe('unavailable')
    expect(revoked).toEqual(['blob:preview-1'])
  })

  it('lets go of the photos that do not fit back in, when the visitor attached others meanwhile', async () => {
    const { attachments, revoked, settle, uploads } = setup()
    attachments.addFiles([photo('a.jpg'), photo('b.jpg'), photo('c.jpg')])
    await settle()
    uploads.forEach((entry, index) => entry.succeed(`image-${index}`))
    await settle()
    attachments.takeForSend()
    attachments.addFiles([photo('d.jpg')])
    await settle()

    attachments.restoreSend(null)

    expect(attachments.getState().attachments.map((attachment) => attachment.fileName)).toEqual(['a.jpg', 'b.jpg', 'd.jpg'])
    expect(revoked).toEqual(['blob:preview-3'])
  })

  it('has nothing to restore or finish when no photos were taken', () => {
    const { attachments } = setup()

    attachments.restoreSend('not_sent')
    attachments.finishSend()

    expect(attachments.getState().attachments).toEqual([])
  })
})

describe('starting a new chat', () => {
  it('drops every photo, including those a send holds, and releases their previews', async () => {
    const { attachments, revoked, uploaded } = setup()
    await uploaded(['a.jpg'])
    attachments.takeForSend()

    attachments.clear()
    attachments.restoreSend(null)

    expect(attachments.getState().attachments).toEqual([])
    expect(revoked).toEqual(['blob:preview-1'])
  })
})

describe('leaving the chat', () => {
  it('stops every upload and releases every preview, those of a send in progress too', async () => {
    const { attachments, uploads, revoked, settle } = setup()
    attachments.addFiles([photo('a.jpg')])
    await settle()
    uploads[0].succeed('image-a')
    await settle()
    attachments.takeForSend()
    attachments.addFiles([photo('b.jpg')])
    await settle()

    attachments.dispose()

    expect(uploads[1].signal.aborted).toBe(true)
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
