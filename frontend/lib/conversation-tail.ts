import type { ChatConversationMessage } from './api-types'

export const mergeTailMessages = (
  existing: ChatConversationMessage[],
  incoming: ChatConversationMessage[],
): ChatConversationMessage[] => {
  const byId = new Map<string, ChatConversationMessage>()

  for (const message of existing) {
    byId.set(message.id, message)
  }

  for (const message of incoming) {
    byId.set(message.id, message)
  }

  return Array.from(byId.values()).sort((left, right) => {
    const createdAtComparison = left.createdAt.localeCompare(right.createdAt)
    return createdAtComparison === 0 ? left.id.localeCompare(right.id) : createdAtComparison
  })
}
