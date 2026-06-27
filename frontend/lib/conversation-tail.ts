import type { ChatConversationMessage } from './api-types'

export const mergeTailMessages = (
  existing: ChatConversationMessage[],
  incoming: ChatConversationMessage[],
): ChatConversationMessage[] => {
  const byId = new Map<string, ChatConversationMessage>()

  for (const message of existing) {
    byId.set(message.id, message)
  }

  // The live-tail endpoint returns lightweight messages without the enrichment
  // fields the detail carries (debug/turn-trace, citations, answerSegments,
  // suggestions). Merge rather than replace so a tail update applies fresh
  // content/source without clobbering those fields — otherwise polling silently
  // strips diagnostics and citations from every message ~1s after open.
  for (const message of incoming) {
    const existingMessage = byId.get(message.id)
    byId.set(message.id, existingMessage ? { ...existingMessage, ...message } : message)
  }

  return Array.from(byId.values()).sort((left, right) => {
    const createdAtComparison = left.createdAt.localeCompare(right.createdAt)
    return createdAtComparison === 0 ? left.id.localeCompare(right.id) : createdAtComparison
  })
}
