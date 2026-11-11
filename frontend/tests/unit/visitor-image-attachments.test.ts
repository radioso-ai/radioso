import { describe, expect, it } from 'vitest'

import {
  MAX_VISITOR_IMAGES_PER_MESSAGE,
  canSendMessage,
  emptyAttachments,
  exceedsUploadCap,
  hasUploadInFlight,
  preUploadFailure,
  readyImageIds,
  reduceAttachments,
  remainingSlots,
  splitByCapacity,
  visitorImageFailureOf,
  type AttachmentAction,
  type AttachmentsState,
  type NewAttachment,
} from '@/lib/visitor-image-attachments'

const item = (key: string, extra: Partial<NewAttachment> = {}): NewAttachment => ({
  key,
  fileName: `${key}.jpg`,
  previewUrl: `blob:${key}`,
  ...extra,
})

const run = (actions: AttachmentAction[], from: AttachmentsState = emptyAttachments) =>
  actions.reduce(reduceAttachments, from)

describe('attachment transitions', () => {
  it('starts an added photo as uploading and marks it ready with its image id', () => {
    const uploading = run([{ type: 'add', items: [item('a')] }])
    expect(uploading.attachments).toEqual([{ key: 'a', fileName: 'a.jpg', previewUrl: 'blob:a', status: 'uploading' }])
    expect(hasUploadInFlight(uploading)).toBe(true)

    const ready = reduceAttachments(uploading, { type: 'uploaded', key: 'a', imageId: 'image-1' })
    expect(ready.attachments[0]).toMatchObject({ key: 'a', status: 'ready', imageId: 'image-1' })
    expect(hasUploadInFlight(ready)).toBe(false)
    expect(readyImageIds(ready)).toEqual(['image-1'])
  })

  it('records the reason a photo failed, and lets the visitor remove it', () => {
    const failed = run([
      { type: 'add', items: [item('a')] },
      { type: 'failed', key: 'a', failure: 'too_large' },
    ])
    expect(failed.attachments[0]).toMatchObject({ key: 'a', status: 'error', failure: 'too_large' })
    expect(readyImageIds(failed)).toEqual([])
    expect(hasUploadInFlight(failed)).toBe(false)

    expect(reduceAttachments(failed, { type: 'remove', key: 'a' }).attachments).toEqual([])
  })

  it('starts a photo refused before upload in its failed state', () => {
    const state = run([{ type: 'add', items: [item('a', { previewUrl: null, failure: 'unsupported_type' })] }])
    expect(state.attachments[0]).toMatchObject({ status: 'error', failure: 'unsupported_type', previewUrl: null })
    expect(hasUploadInFlight(state)).toBe(false)
  })

  it('ignores the outcome of an upload whose photo was removed meanwhile', () => {
    const removed = run([
      { type: 'add', items: [item('a'), item('b')] },
      { type: 'remove', key: 'a' },
    ])
    expect(reduceAttachments(removed, { type: 'uploaded', key: 'a', imageId: 'late' })).toBe(removed)
    expect(reduceAttachments(removed, { type: 'failed', key: 'a', failure: 'failed' })).toBe(removed)
    expect(removed.attachments.map((attachment) => attachment.key)).toEqual(['b'])
  })

  it('keeps the photos in the order they were added', () => {
    const state = run([
      { type: 'add', items: [item('a'), item('b')] },
      { type: 'uploaded', key: 'b', imageId: 'image-b' },
      { type: 'uploaded', key: 'a', imageId: 'image-a' },
    ])
    expect(readyImageIds(state)).toEqual(['image-a', 'image-b'])
  })

  it('clears every photo after a send', () => {
    const state = run([
      { type: 'add', items: [item('a'), item('b')] },
      { type: 'uploaded', key: 'a', imageId: 'image-a' },
      { type: 'clear' },
    ])
    expect(state).toEqual(emptyAttachments)
  })
})

describe('the three-photo limit', () => {
  it('takes photos up to the limit and flags the ones that did not fit', () => {
    const state = run([{ type: 'add', items: [item('a'), item('b'), item('c'), item('d'), item('e')] }])
    expect(state.attachments.map((attachment) => attachment.key)).toEqual(['a', 'b', 'c'])
    expect(MAX_VISITOR_IMAGES_PER_MESSAGE).toBe(3)
    expect(remainingSlots(state)).toBe(0)
    expect(state.limitReached).toBe(true)
  })

  it('counts a failed photo against the limit until it is removed', () => {
    const state = run([
      { type: 'add', items: [item('a'), item('b'), item('c')] },
      { type: 'failed', key: 'a', failure: 'failed' },
    ])
    expect(remainingSlots(state)).toBe(0)

    const afterRemove = reduceAttachments(state, { type: 'remove', key: 'a' })
    expect(remainingSlots(afterRemove)).toBe(1)
    expect(afterRemove.limitReached).toBe(false)
  })

  it('reports which of the new photos fit, so the caller uploads only those', () => {
    const state = run([{ type: 'add', items: [item('a'), item('b')] }])
    const split = splitByCapacity(state, [item('c'), item('d')])
    expect(split.accepted.map((accepted) => accepted.key)).toEqual(['c'])
    expect(split.overflow.map((overflow) => overflow.key)).toEqual(['d'])
  })

  it('clears the limit notice on the next add that fits', () => {
    const full = run([{ type: 'add', items: [item('a'), item('b'), item('c'), item('d')] }])
    const room = reduceAttachments(full, { type: 'remove', key: 'a' })
    expect(reduceAttachments(room, { type: 'add', items: [item('e')] }).limitReached).toBe(false)
  })
})

describe('when a message can be sent', () => {
  it('needs text or at least one uploaded photo', () => {
    expect(canSendMessage('', emptyAttachments)).toBe(false)
    expect(canSendMessage('   ', emptyAttachments)).toBe(false)
    expect(canSendMessage('hello', emptyAttachments)).toBe(true)

    const ready = run([
      { type: 'add', items: [item('a')] },
      { type: 'uploaded', key: 'a', imageId: 'image-a' },
    ])
    expect(canSendMessage('', ready)).toBe(true)
  })

  it('waits for every upload in flight, text or not', () => {
    const uploading = run([{ type: 'add', items: [item('a')] }])
    expect(canSendMessage('hello', uploading)).toBe(false)
    expect(canSendMessage('', uploading)).toBe(false)
  })

  it('does not count a failed photo as something to send', () => {
    const failed = run([
      { type: 'add', items: [item('a')] },
      { type: 'failed', key: 'a', failure: 'failed' },
    ])
    expect(canSendMessage('', failed)).toBe(false)
    expect(canSendMessage('hello', failed)).toBe(true)
  })
})

describe('photo failures', () => {
  it('refuses a type the server would refuse, before uploading, and leaves an unknown type to the server', () => {
    expect(preUploadFailure({ type: 'image/gif' })).toBe('unsupported_type')
    expect(preUploadFailure({ type: 'application/pdf' })).toBe('unsupported_type')
    expect(preUploadFailure({ type: 'image/jpeg' })).toBeNull()
    expect(preUploadFailure({ type: 'image/png' })).toBeNull()
    expect(preUploadFailure({ type: 'image/webp' })).toBeNull()
    expect(preUploadFailure({ type: '' })).toBeNull()
  })

  it('knows a file over the 10 MiB upload cap', () => {
    expect(exceedsUploadCap({ size: 10 * 1024 * 1024 })).toBe(false)
    expect(exceedsUploadCap({ size: 10 * 1024 * 1024 + 1 })).toBe(true)
  })

  it.each([
    [{ error: { code: 'unsupported_image_type' }, status: 415 }, 'unsupported_type'],
    [{ error: { code: 'image_too_large' }, status: 413 }, 'too_large'],
    [{ error: { code: 'image_too_many_pixels' }, status: 413 }, 'too_large'],
    [{ error: { code: 'visitor_images_unavailable' }, status: 404 }, 'unavailable'],
    [{ error: { code: 'rate_limit_exceeded' }, status: 429 }, 'failed'],
    [{ error: { code: 'internal_error' }, status: 500 }, 'failed'],
    [new TypeError('Failed to fetch'), 'failed'],
    [undefined, 'failed'],
  ])('reads the upload error %j as %s', (error, expected) => {
    expect(visitorImageFailureOf(error)).toBe(expected)
  })
})
