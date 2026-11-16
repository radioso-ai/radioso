import { stripMarkdownSyntax } from '@/lib/markdown-preview'
import { visibleMessageLabel } from '@/lib/visitor-image-input'

/** The minimal conversation shape the display-title fallback chain needs. */
interface ConversationTitleSource {
  /** LLM-generated topic label (backend issue #1114). Null until the first successful regeneration. */
  title?: string | null
  /** The words of the conversation's opening message, used while no title has been generated yet. */
  preview?: string | null
  /** The photos that message carried; a conversation nobody wrote a word in previews as this count alone. */
  previewPhotoCount?: number | null
}

/**
 * Resolves what a conversation row (or an ambient Ray entity label) shows as its
 * title. The generated topic label wins once one exists; before that (or if it is
 * ever blank), the row falls back to the visitor's opening message, and finally to
 * a generic label so a row is never blank. Shared by the All-lens list
 * (`all-conversations-list-pane.tsx`) and the Needs-you queue (`needs-attention.ts`)
 * so the two surfaces can never drift on what a row is titled.
 */
export function resolveConversationDisplayTitle(
  conversation: ConversationTitleSource,
  fallback = 'Untitled conversation',
): string {
  const title = conversation.title?.trim()
  if (title) {
    return title
  }
  return visibleMessageLabel({
    text: stripMarkdownSyntax(conversation.preview || ''),
    photoCount: conversation.previewPhotoCount ?? 0,
  }) || fallback
}
