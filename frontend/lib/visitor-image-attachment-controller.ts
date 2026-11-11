import {
  VISITOR_IMAGE_BUSY_RETRY_MS,
  emptyAttachments,
  exceedsUploadCap,
  preUploadFailure,
  readyImageIds,
  reduceAttachments,
  splitByCapacity,
  visitorImageFailureOf,
  type AttachmentAction,
  type AttachmentsState,
  type NewAttachment,
  type VisitorImageFailure,
} from '@/lib/visitor-image-attachments'
import { downsizeVisitorImage, type ImageCodec } from '@/lib/visitor-image-downsize'

export interface VisitorImageAttachmentDeps {
  /** Uploads one photo and answers with the id the server gave it; rejects with the API's error. */
  upload(file: File, signal: AbortSignal): Promise<{ id: string }>
  codec: ImageCodec
  /** Object URLs for the preview chips. */
  previews: { create(file: Blob): string; revoke(url: string): void }
  createKey(): string
  /** Waits `ms`, or less when `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void>
}

/**
 * The photos of the message being composed: it shrinks each one, uploads it, and keeps the
 * `AttachmentsState` the composer shows. A removed photo's upload is stopped and its answer
 * ignored; every preview it makes is released. It is a store (`getState`, `subscribe`) so a hook can
 * read it without holding the work in React state.
 */
export class VisitorImageAttachments {
  private state: AttachmentsState = emptyAttachments
  private readonly listeners = new Set<() => void>()
  private readonly uploads = new Map<string, AbortController>()
  private readonly previewUrls = new Map<string, string>()

  constructor(private deps: VisitorImageAttachmentDeps) {}

  /** The upload can change between renders (it closes over the chat session); the work in flight keeps the one it started with. */
  setUpload(upload: VisitorImageAttachmentDeps['upload']): void {
    this.deps = { ...this.deps, upload }
  }

  getState = (): AttachmentsState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  addFiles(files: readonly File[]): void {
    const entries = files.map((file) => ({ key: this.deps.createKey(), file, failure: preUploadFailure(file) }))
    const { accepted } = splitByCapacity(this.state, entries)
    const acceptedKeys = new Set(accepted.map((entry) => entry.key))
    const items: NewAttachment[] = entries.map(({ key, file, failure }) => {
      const previewUrl = acceptedKeys.has(key) && !failure ? this.deps.previews.create(file) : null
      if (previewUrl) {
        this.previewUrls.set(key, previewUrl)
      }
      return { key, fileName: file.name, previewUrl, ...(failure ? { failure } : {}) }
    })
    this.apply({ type: 'add', items })
    for (const { key, file, failure } of accepted) {
      if (!failure) {
        void this.upload(key, file)
      }
    }
  }

  remove(key: string): void {
    this.stopUpload(key)
    this.releasePreview(key)
    this.apply({ type: 'remove', key })
  }

  /** The ids of the uploaded photos, for the message about to be sent; the composer is left empty. */
  takeForSend(): string[] {
    const ids = readyImageIds(this.state)
    this.clear()
    return ids
  }

  /** Records that the server refused a send for its photos, which `takeForSend` already took out of the composer. */
  refuseSend(failure: VisitorImageFailure): void {
    this.apply({ type: 'sendRefused', failure })
  }

  /** Drops every photo, as a new chat does. */
  clear(): void {
    this.dispose()
    this.apply({ type: 'clear' })
  }

  /** Stops every upload and releases every preview. */
  dispose(): void {
    for (const key of [...this.uploads.keys()]) {
      this.stopUpload(key)
    }
    for (const key of [...this.previewUrls.keys()]) {
      this.releasePreview(key)
    }
  }

  private async upload(key: string, original: File): Promise<void> {
    const controller = new AbortController()
    this.uploads.set(key, controller)
    try {
      const file = await downsizeVisitorImage(original, this.deps.codec)
      if (controller.signal.aborted) {
        return
      }
      if (exceedsUploadCap(file)) {
        this.apply({ type: 'failed', key, failure: 'too_large' })
        return
      }
      const uploaded = await this.uploadRetryingWhenBusy(file, controller.signal)
      this.apply({ type: 'uploaded', key, imageId: uploaded.id })
    } catch (error) {
      if (!controller.signal.aborted) {
        this.apply({ type: 'failed', key, failure: visitorImageFailureOf(error) })
      }
    } finally {
      if (this.uploads.get(key) === controller) {
        this.uploads.delete(key)
      }
    }
  }

  /** A server decoding as many photos as it takes at once asks for another try: one more, after a short wait. */
  private async uploadRetryingWhenBusy(file: File, signal: AbortSignal): Promise<{ id: string }> {
    try {
      return await this.deps.upload(file, signal)
    } catch (error) {
      if (visitorImageFailureOf(error) !== 'busy') {
        throw error
      }
      await this.deps.wait(VISITOR_IMAGE_BUSY_RETRY_MS, signal)
      if (signal.aborted) {
        throw error
      }
      return this.deps.upload(file, signal)
    }
  }

  private stopUpload(key: string): void {
    this.uploads.get(key)?.abort()
    this.uploads.delete(key)
  }

  private releasePreview(key: string): void {
    const url = this.previewUrls.get(key)
    if (url) {
      this.deps.previews.revoke(url)
      this.previewUrls.delete(key)
    }
  }

  private apply(action: AttachmentAction): void {
    const next = reduceAttachments(this.state, action)
    if (next !== this.state) {
      this.state = next
      this.listeners.forEach((listener) => listener())
    }
  }
}
