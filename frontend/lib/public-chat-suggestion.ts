import type { ChatSuggestion, ChatUserInputMetadata } from './api'

/**
 * How the public chat reports a clicked suggestion chip: one that starts an intent sends the
 * intent, any other sends the click. Both name the message the chip came with.
 */
export const suggestionInputMetadata = (suggestion: ChatSuggestion, messageId: string): ChatUserInputMetadata =>
  suggestion.action?.kind === 'start_intent'
    ? {
        method: 'intent_click',
        intent: suggestion.action.intent,
        suggestionSourceMessageId: messageId,
      }
    : {
        method: 'suggestion_click',
        suggestionSourceMessageId: messageId,
      }
