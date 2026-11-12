import {
  VISITOR_IMAGE_BUSY_RETRY_MS,
  emptyAttachments,
  exceedsUploadCap,
  preUploadFailure,
  reduceAttachments,
  splitByCapacity,
  visitorImageFailureOf,
  type Attachment,
  type AttachmentAction,
  type AttachmentsState,
  type NewAttachment,
  type SendFailure,
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

type ReadyAttachment = Extract<Attachment, { status: 'ready' }>

/**
 * The photos of the message being composed: it shrinks each one, one at a time, uploads it, and
 * keeps the `AttachmentsState` the composer shows. A chip previews the photo as it was shrunk, not
 * the original. A removed photo's upload is stopped and its answer ignored; every preview it makes
 * is released. A send takes the uploaded photos out of the composer but holds them, previews and
 * all, until the server has claimed them (`finishSend`) or has not (`restoreSend`). It is a store
 * (`getState`, `subscribe`) so a hook can read it without holding the work in React state.
 */
export class VisitorImageAttachments {
  private state: AttachmentsState = emptyAttachments
  private readonly listeners = new Set<() => void>()
  private readonly uploads = new Map<string, AbortController>()
  private readonly previewUrls = new Map<string, string>()
  /** Photos wait here for their turn to be decoded: a phone cannot hold several full-size photos at once. */
  private shrinking: Promise<unknown> = Promise.resolve()
  private held: ReadyAttachment[] = []

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
    this.apply({
      type: 'add',
      items: entries.map<NewAttachment>(({ key, file, failure }) => ({ key, fileName: file.name, previewUrl: null, ...(failure ? { failure } : {}) })),
    })
    for (const { key, file, failure } of accepted) {
      if (!failure) {
        this.enqueue(key, file)
      }
    }
  }

  remove(key: string): void {
    this.stopUpload(key)
    this.releasePreview(key)
    this.apply({ type: 'remove', key })
  }

  /**
   * The ids of the uploaded photos, for the message about to be sent. The composer is left empty,
   * but the photos are held, with their previews, until `finishSend` or `restoreSend`.
   */
  takeForSend(): string[] {
    const ready = this.state.attachments.filter((attachment): attachment is ReadyAttachment => attachment.status === 'ready')
    for (const attachment of this.state.attachments) {
      if (attachment.status !== 'ready') {
        this.stopUpload(attachment.key)
        this.releasePreview(attachment.key)
      }
    }
    this.held = ready
    this.apply({ type: 'clear' })
    return ready.map((attachment) => attachment.imageId)
  }

  /** The server took the photos, or refused them for good: the held photos go, and their previews. */
  finishSend(): void {
    this.held.forEach((attachment) => this.releasePreview(attachment.key))
    this.held = []
  }

  /** Says why a send did not take its photos, until the visitor attaches or removes something. */
  notice(failure: SendFailure): void {
    this.apply({ type: 'notice', failure })
  }

  /** The server did not take the photos: they come back as they were, uploaded and previewed, and `failure` says what happened. */
  restoreSend(failure: SendFailure | null): void {
    const held = this.held
    this.held = []
    const { overflow } = splitByCapacity(this.state, held)
    overflow.forEach((attachment) => this.releasePreview(attachment.key))
    if (held.length > 0 || failure) {
      this.apply({ type: 'restore', attachments: held, sendFailure: failure })
    }
  }

  /** Drops every photo, as a new chat does. */
  clear(): void {
    this.dispose()
    this.apply({ type: 'clear' })
  }

  /** Stops every upload and releases every preview, those of a send in progress too. */
  dispose(): void {
    for (const key of [...this.uploads.keys()]) {
      this.stopUpload(key)
    }
    for (const key of [...this.previewUrls.keys()]) {
      this.releasePreview(key)
    }
    this.held = []
  }

  private enqueue(key: string, original: File): void {
    const controller = new AbortController()
    this.uploads.set(key, controller)
    const shrunk = this.shrinking.then(() => (controller.signal.aborted ? null : downsizeVisitorImage(original, this.deps.codec)))
    this.shrinking = shrunk.catch(() => undefined)
    void shrunk.then(
      (file) => this.upload(key, file, controller),
      () => this.uploads.delete(key),
    )
  }

  private async upload(key: string, file: File | null, controller: AbortController): Promise<void> {
    try {
      if (!file || controller.signal.aborted) {
        return
      }
      const previewUrl = this.deps.previews.create(file)
      this.previewUrls.set(key, previewUrl)
      this.apply({ type: 'previewed', key, previewUrl })
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
