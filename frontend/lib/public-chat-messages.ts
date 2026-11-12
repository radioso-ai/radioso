import { isHumanAuthoredSource } from '@/lib/reply-attribution'
import type {
  ActivitySummary,
  ActivityTrace,
  AnswerFeedbackEntry,
  AnswerFeedbackState,
  AnswerSegment,
  ChatConversationDetail,
  ChatSuggestion,
  ChatUserInputMetadata,
  Citation,
  SkillStreamPayload,
} from '@/lib/api'

/** A message in the visitor's thread, as the public chat keeps it: from history, or as it streams in. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  inputMetadata?: ChatUserInputMetadata
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  suggestions?: ChatSuggestion[]
  answerFeedback?: AnswerFeedbackState
  answerFeedbackEntries?: AnswerFeedbackEntry[]
  activitySummary?: ActivitySummary
  activityTrace?: ActivityTrace
  persistedAssistantMessageId?: string
  status: 'complete' | 'streaming' | 'error'
  /** Narrows why an `error` status happened, so the view can show cause-specific
   *  copy instead of the generic failure message. Absent for every other failure
   *  (provider outage, timeout, etc.), which keeps the generic copy. */
  failure?: 'unavailable'
  skill?: SkillStreamPayload
  /** Message provenance, so the visitor can tell a human operator reply from the AI. */
  source?: ChatConversationDetail['messages'][number]['source']
  /** Display name of the human operator who sent this reply (takeover). */
  operatorDisplayName?: string
}

const resolveOwnFeedback = (
  entries: AnswerFeedbackEntry[] | undefined,
  chatSessionId: string | null | undefined,
): AnswerFeedbackState | undefined => {
  const entry = entries?.find((feedback) =>
    feedback.actorType === 'anonymous_user' &&
    feedback.anonymousSessionId === chatSessionId,
  )
  return entry ? { value: entry.value, comment: entry.comment } : undefined
}

const stripPublicSuggestionCitation = (suggestion: ChatSuggestion): ChatSuggestion => {
  const publicSuggestion = { ...suggestion }
  delete publicSuggestion.citation
  return publicSuggestion
}

export const stripPublicSuggestionCitations = (suggestions?: ChatSuggestion[]) =>
  suggestions?.map(stripPublicSuggestionCitation)

export const toPublicAnswerSegments = (answerSegments?: AnswerSegment[]) =>
  answerSegments?.map((segment) => ({
    text: segment.text,
    ...(segment.citationIndices ? { citationIndices: segment.citationIndices } : {}),
  }))

export const toChatMessagesFromTurns = (
  messages: ChatConversationDetail['messages'],
  chatSessionId?: string | null,
): ChatMessage[] =>
  messages
    .filter((message): message is typeof message & { role: 'user' | 'assistant' } => message.role !== 'system')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      inputMetadata: message.inputMetadata,
      citations: message.citations,
      answerSegments: toPublicAnswerSegments(message.answerSegments),
      suggestions: stripPublicSuggestionCitations(message.suggestions),
      answerFeedback: message.role === 'assistant'
        ? resolveOwnFeedback(message.answerFeedbackEntries, chatSessionId)
        : undefined,
      answerFeedbackEntries: message.role === 'assistant' ? message.answerFeedbackEntries : undefined,
      activitySummary: message.debug?.activitySummary,
      activityTrace: message.debug?.activityTrace,
      persistedAssistantMessageId: message.role === 'assistant' ? message.id : undefined,
      status: 'complete' as const,
      source: message.source,
      operatorDisplayName: message.operatorDisplayName,
    }))

export const toChatMessages = (
  detail: ChatConversationDetail,
  chatSessionId?: string | null,
): ChatMessage[] => toChatMessagesFromTurns(detail.messages, chatSessionId)

export const isHumanAgentReply = (message: ChatConversationDetail['messages'][number]) =>
  message.role === 'assistant' && isHumanAuthoredSource(message.source)

export const restoreMessageSuggestions = (
  messages: ChatMessage[],
  previousMessages: ChatMessage[],
): ChatMessage[] => {
  const suggestionsByMessageId = new Map(
    previousMessages
      .filter((message) => message.suggestions && message.suggestions.length > 0)
      .map((message) => [message.id, message.suggestions]),
  )

  return messages.map((message) =>
    suggestionsByMessageId.has(message.id)
      ? {
          ...message,
          suggestions: suggestionsByMessageId.get(message.id),
        }
      : message,
  )
}

/** The thread as it was before a turn that did not run: both of its messages gone and the suggestions back. */
export const withoutTurn = (
  messages: ChatMessage[],
  turnMessageIds: readonly string[],
  messagesBefore: ChatMessage[],
): ChatMessage[] =>
  restoreMessageSuggestions(messages.filter((message) => !turnMessageIds.includes(message.id)), messagesBefore)
