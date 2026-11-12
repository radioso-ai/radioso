import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  VISITOR_IMAGE_CACHE_LIMIT,
  clearVisitorImageCache,
  loadVisitorImage,
  rememberVisitorImage,
} from '@/lib/visitor-image-blob-cache'

const blobOf = (label: string) => new Blob([label], { type: 'image/jpeg' })

describe('the visitor image cache', () => {
  beforeEach(() => clearVisitorImageCache())

  it('fetches a photo once and serves it from memory afterwards', async () => {
    const fetchBlob = vi.fn(async () => blobOf('a'))

    const first = await loadVisitorImage('token:image-a', fetchBlob)
    const second = await loadVisitorImage('token:image-a', fetchBlob)

    expect(fetchBlob).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('shares one fetch between thumbnails that ask for the same photo at once', async () => {
    let resolve: (blob: Blob) => void = () => undefined
    const fetchBlob = vi.fn(() => new Promise<Blob>((done) => { resolve = done }))

    const a = loadVisitorImage('token:image-a', fetchBlob)
    const b = loadVisitorImage('token:image-a', fetchBlob)
    resolve(blobOf('a'))

    expect(await a).toBe(await b)
    expect(fetchBlob).toHaveBeenCalledTimes(1)
  })

  it('serves a photo the composer already has without fetching it', async () => {
    const preview = blobOf('preview')
    rememberVisitorImage('token:image-a', preview)
    const fetchBlob = vi.fn(async () => blobOf('server'))

    await expect(loadVisitorImage('token:image-a', fetchBlob)).resolves.toBe(preview)
    expect(fetchBlob).not.toHaveBeenCalled()
  })

  it('does not keep a failed fetch, so the next thumbnail tries again', async () => {
    const fetchBlob = vi.fn<() => Promise<Blob>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(blobOf('a'))

    await expect(loadVisitorImage('token:image-a', fetchBlob)).rejects.toThrow('offline')
    await expect(loadVisitorImage('token:image-a', fetchBlob)).resolves.toBeInstanceOf(Blob)
    expect(fetchBlob).toHaveBeenCalledTimes(2)
  })

  it('forgets the photo it has held longest once it holds too many', async () => {
    for (let index = 0; index < VISITOR_IMAGE_CACHE_LIMIT + 1; index += 1) {
      rememberVisitorImage(`token:image-${index}`, blobOf(String(index)))
    }
    const fetchBlob = vi.fn(async () => blobOf('refetched'))

    await loadVisitorImage('token:image-0', fetchBlob)
    expect(fetchBlob).toHaveBeenCalledTimes(1)

    await loadVisitorImage(`token:image-${VISITOR_IMAGE_CACHE_LIMIT}`, fetchBlob)
    expect(fetchBlob).toHaveBeenCalledTimes(1)
  })
})
