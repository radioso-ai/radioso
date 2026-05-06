import type {
  AnswerSegment,
  ChatResponse,
  ChatStreamChunk,
  ChatStreamCompletion,
  ChatStreamConversation,
  ChatStreamHandlers,
  ChatStreamSuggestions,
  ChatSuggestion,
  Citation,
  RetrievalInfo,
  RetrievalTrace,
} from './api'

const parseSseEvent = (rawEvent: string) => {
  const normalized = rawEvent.replaceAll('\r', '')
  const lines = normalized.split('\n')
  let eventName = 'message'
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      continue
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }

  return {
    eventName,
    data: dataLines.join('\n'),
  }
}

export const streamChatEvents = async (
  response: Response,
  handlers: ChatStreamHandlers,
): Promise<ChatResponse> => {
  if (!response.body) {
    throw new Error('Streaming response body was unavailable.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  let conversationId = ''
  let citations: Citation[] | undefined
  let answerSegments: AnswerSegment[] | undefined
  let suggestions: ChatSuggestion[] | undefined
  let assistantMessageId: string | undefined
  let conversationMode: ChatResponse['conversationMode'] | undefined
  let conversationModeMetadata: ChatResponse['conversationModeMetadata'] | undefined
  let retrievalInfo: RetrievalInfo | undefined
  let retrievalTrace: RetrievalTrace | undefined
  let route: ChatResponse['route'] | undefined

  const flushEvent = (rawEvent: string) => {
    if (!rawEvent.trim()) {
      return
    }

    const { eventName, data } = parseSseEvent(rawEvent)

    if (!data) {
      return
    }

    const payload = JSON.parse(data) as
      | (ChatStreamConversation & { type?: 'conversation' })
      | (ChatStreamChunk & { type?: 'chunk' })
      | (ChatStreamSuggestions & { type?: 'suggestions' })
      | (ChatStreamCompletion & { type?: 'done' })

    const normalizedEventName =
      eventName === 'message' && 'type' in payload && typeof payload.type === 'string'
        ? payload.type
        : eventName

    if (normalizedEventName === 'conversation') {
      const conversationPayload = payload as ChatStreamConversation
      conversationId = conversationPayload.conversationId
      handlers.onConversation?.(conversationPayload)
      return
    }

    if (normalizedEventName === 'chunk') {
      const chunkPayload = payload as ChatStreamChunk
      answer = `${answer}${chunkPayload.text}`
      handlers.onChunk?.(chunkPayload)
      return
    }

    if (normalizedEventName === 'done') {
      const completionPayload = payload as ChatStreamCompletion
      conversationId = completionPayload.conversationId ?? conversationId
      assistantMessageId = completionPayload.assistantMessageId ?? assistantMessageId
      answer = completionPayload.answer ?? answer
      citations = completionPayload.citations
      answerSegments = completionPayload.answerSegments
      suggestions = completionPayload.suggestions
      conversationMode = completionPayload.conversationMode
      conversationModeMetadata = completionPayload.conversationModeMetadata
      retrievalInfo = completionPayload.retrievalInfo
      retrievalTrace = completionPayload.retrievalTrace
      route = completionPayload.route
      handlers.onDone?.({
        conversationId,
        assistantMessageId,
        route,
        answer,
        citations,
        answerSegments,
        suggestions,
        conversationMode,
        conversationModeMetadata,
        retrievalInfo,
        retrievalTrace,
      })
      return
    }

    if (normalizedEventName === 'suggestions') {
      const suggestionsPayload = payload as ChatStreamSuggestions
      conversationId = suggestionsPayload.conversationId ?? conversationId
      suggestions = suggestionsPayload.suggestions
      conversationModeMetadata = suggestionsPayload.conversationModeMetadata ?? conversationModeMetadata
      handlers.onSuggestions?.({
        conversationId,
        suggestions,
        conversationModeMetadata,
      })
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

    let delimiterIndex = buffer.indexOf('\n\n')

    while (delimiterIndex !== -1) {
      flushEvent(buffer.slice(0, delimiterIndex))
      buffer = buffer.slice(delimiterIndex + 2)
      delimiterIndex = buffer.indexOf('\n\n')
    }

    if (done) {
      break
    }
  }

  if (buffer.trim()) {
    flushEvent(buffer)
  }

  return {
    conversationId,
    assistantMessageId,
    route,
    answer,
    citations,
    answerSegments,
    suggestions,
    conversationMode: conversationMode!,
    conversationModeMetadata: conversationModeMetadata!,
    retrievalInfo: retrievalInfo!,
    retrievalTrace: retrievalTrace!,
  }
}
