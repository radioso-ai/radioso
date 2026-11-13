import type { VisitorImageInput } from '@/lib/api-types'
import type { Attachment, SendFailure } from '@/lib/visitor-image-attachments'

/** What the composer needs to attach photos and to say why a send did not take them. */
export interface ComposerImages {
  attachments: readonly Attachment[]
  /** The agent takes photos: the attach control, paste and drop are offered. False while a notice still has to be read. */
  canAttach: boolean
  /** A paste or drop carried more photos than the message has room for. */
  limitReached: boolean
  /** Why the last send did not take its photos, which are no longer here (or are back). */
  sendFailure: SendFailure | null
  onFiles: (files: File[]) => void
  onRemove: (key: string) => void
}

/**
 * Where a thread reads a visitor's photos from. The visitor's own chat reads them with the public
 * session header, which `<img src>` cannot send, so it fetches and shows a blob. A teammate reads
 * them with the dashboard session, which `<img src>` carries, so a photo loads once it is on screen
 * and each view is audited: a conversation's from the conversation, and Test Chat's from the test,
 * which keeps its transcript apart from conversations.
 */
export type VisitorImageSource =
  | { kind: 'public'; publicChatToken: string }
  | { kind: 'operator'; workspaceId: string; conversationId: string }
  | { kind: 'test_chat'; workspaceId: string; agentId: string; executionId: string }

export interface VisitorImageThreadConfig {
  source: VisitorImageSource
  /** Alt text of a photo, and the label that stands in for one that cannot be shown. */
  altLabel: string
  unavailableLabel: string
  /**
   * Set on teammate threads, which keep the agent's reading of each photo behind a disclosure. A
   * photo in `pendingIds` was just sent and its reading is not back yet, so it shows `pendingLabel`.
   */
  readings?: { label: string; unreadLabel: string; pendingLabel?: string; pendingIds?: ReadonlySet<string> }
}

export type VisitorImage = VisitorImageInput['images'][number]
