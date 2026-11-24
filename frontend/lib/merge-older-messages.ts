import type { ChatConversationDetail } from '@/lib/api-types'

/** The open detail with an older page of messages ahead of its own; an older page carries no attributes, so the first page's stay. */
export const mergeOlderMessages = (current: ChatConversationDetail | null, older: ChatConversationDetail): ChatConversationDetail => {
  if (!current) return older
  return {
    ...older,
    ...(current.attributes ? { attributes: current.attributes } : {}),
    ...(current.attributesEditable !== undefined ? { attributesEditable: current.attributesEditable } : {}),
    messages: [...older.messages, ...current.messages],
  }
}
