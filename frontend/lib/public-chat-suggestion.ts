import type { ChatSuggestion, ChatUserInputMetadata } from './api'

/**
 * How the public chat reports a clicked suggestion chip: one that starts an intent sends the
 * intent, any other sends the click, with the chip's id when it has one (an authored chip, such as
 * a routine consent's `agree` or `decline`, which the agent records as the visitor's decision).
 * Both name the message the chip came with.
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
        ...(suggestion.id ? { suggestionId: suggestion.id } : {}),
      }
