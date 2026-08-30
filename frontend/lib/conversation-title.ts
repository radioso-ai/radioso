import { stripMarkdownSyntax } from '@/lib/markdown-preview'

/** The minimal conversation shape the display-title fallback chain needs. */
export interface ConversationTitleSource {
  /** LLM-generated topic label (backend issue #1114). Null until the first successful regeneration. */
  title?: string | null
  /** The conversation's first-message preview, used while no title has been generated yet. */
  preview?: string | null
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
  return stripMarkdownSyntax(conversation.preview || '') || fallback
}
