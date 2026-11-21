import type { ChatUserInputMetadata } from './api-types'
import type { ItemSelection } from './reply-blocks'

/** A card picked in Test Chat: the card's words, sent as the message, and the card they name. */
export interface TestChatPick {
  message: string
  selection: ItemSelection
}

/**
 * The pick a card's Select sends through the chat thread (`itemPickMessage`), as Test Chat sends
 * it. Null for anything the thread sends that is not a pick.
 */
export const testChatPickOf = (content: string, inputMetadata: ChatUserInputMetadata): TestChatPick | null =>
  inputMetadata.method === 'item_select' && inputMetadata.selection && content.trim()
    ? { message: content.trim(), selection: inputMetadata.selection }
    : null

/**
 * A Test Chat send's body: a pick goes as the card's words with the card, alone, as live chat
 * sends one; otherwise what the operator typed, with the photos they attached.
 */
export const testChatMessageBody = (input: {
  text: string
  imageIds: readonly string[]
  pick: TestChatPick | null
  executionGeneration: number
  turnId: string
  attemptId: string
}) => {
  const { text, imageIds, pick, ...turn } = input
  if (pick) return { message: pick.message, selection: pick.selection, ...turn }
  return { ...(text ? { message: text } : {}), ...(imageIds.length > 0 ? { imageIds: [...imageIds] } : {}), ...turn }
}
