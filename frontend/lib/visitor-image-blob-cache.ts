/**
 * The visitor's own photos, held in memory so a thumbnail does not fetch the same bytes twice. A
 * photo is read with the public session header, which an `<img src>` cannot send, so the thread
 * fetches it and shows a blob URL; this keeps the blob between the composer's preview, the
 * optimistic message and a remount. It is bounded, and a failed fetch is never kept.
 */
export const VISITOR_IMAGE_CACHE_LIMIT = 24

/** A photo is the session's: the same id under another chat token is not the same cache entry. */
export const visitorImageCacheKey = (publicChatToken: string, imageId: string): string => `${publicChatToken}:${imageId}`

const blobs = new Map<string, Blob>()
const inFlight = new Map<string, Promise<Blob>>()

const keep = (key: string, blob: Blob) => {
  blobs.delete(key)
  blobs.set(key, blob)
  while (blobs.size > VISITOR_IMAGE_CACHE_LIMIT) {
    const oldest = blobs.keys().next().value
    if (oldest === undefined) {
      break
    }
    blobs.delete(oldest)
  }
}

/** Remembers a photo the browser already has, such as the one just uploaded. */
export const rememberVisitorImage = (key: string, blob: Blob): void => keep(key, blob)

export const loadVisitorImage = (key: string, fetchBlob: () => Promise<Blob>): Promise<Blob> => {
  const cached = blobs.get(key)
  if (cached) {
    keep(key, cached)
    return Promise.resolve(cached)
  }
  const pending = inFlight.get(key)
  if (pending) {
    return pending
  }
  const request = fetchBlob()
    .then((blob) => {
      keep(key, blob)
      return blob
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, request)
  return request
}

export const clearVisitorImageCache = (): void => {
  blobs.clear()
  inFlight.clear()
}
