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

/** The messages with every chip dropped: a stretch of thread that something newer already answers. */
export const clearMessageSuggestions = <M extends { suggestions?: unknown[] }>(messages: M[]): M[] =>
  messages.map((message) => (message.suggestions?.length ? { ...message, suggestions: undefined } : message))

/**
 * A restored thread's chips, kept only where the visitor can still act on them: on the newest
 * message, while it is the agent's and nothing has answered it. History returns every message's
 * chips as they were offered, and the live thread drops them once the visitor sends, so without
 * this a reload would bring back chips already answered, such as a decided consent's buttons.
 */
export const actionableSuggestionsOnly = <M extends { role: string; suggestions?: unknown[] }>(messages: M[]): M[] =>
  messages.map((message, index) =>
    message.suggestions?.length && (index < messages.length - 1 || message.role !== 'assistant')
      ? { ...message, suggestions: undefined }
      : message,
  )
