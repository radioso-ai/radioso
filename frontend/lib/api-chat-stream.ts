import type {
  AnswerSegment,
  ChatResponse,
  ChatStreamChunk,
  ChatStreamCancelled,
  ChatStreamCompletion,
  ChatStreamConversation,
  ChatStreamHandlers,
  ChatStreamSkill,
  ChatStreamStatus,
  ChatStreamSuggestions,
  ChatSuggestion,
  Citation,
  ActivitySummary,
  ActivityTrace,
} from './api-types'

export const parseSseEvent = (rawEvent: string) => {
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
  let agentId: string | undefined
  let agentName: string | undefined
  let activitySummary: ActivitySummary | undefined
  let activityTrace: ActivityTrace | undefined
  let route: ChatResponse['route'] | undefined
  let ownership: ChatResponse['ownership'] | undefined
  let cancelled = false

  const flushEvent = (rawEvent: string) => {
    if (!rawEvent.trim()) {
      return
    }

    if (cancelled) {
      return
    }

    const { eventName, data } = parseSseEvent(rawEvent)

    if (!data) {
      return
    }

    const payload = JSON.parse(data) as
      | (ChatStreamConversation & { type?: 'conversation' })
      | (ChatStreamStatus & { type?: 'status' })
      | (ChatStreamChunk & { type?: 'chunk' })
      | (ChatStreamCancelled & { type?: 'cancelled' })
      | (ChatStreamSuggestions & { type?: 'suggestions' })
      | (ChatStreamSkill & { type?: 'skill' })
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

    if (normalizedEventName === 'status') {
      const statusPayload = payload as ChatStreamStatus
      if (
        statusPayload.stage === 'interpreting' ||
        statusPayload.stage === 'searching' ||
        statusPayload.stage === 'composing'
      ) {
        handlers.onStatus?.(statusPayload)
      }
      return
    }

    if (normalizedEventName === 'chunk') {
      const chunkPayload = payload as ChatStreamChunk
      answer = `${answer}${chunkPayload.text}`
      handlers.onChunk?.(chunkPayload)
      return
    }

    if (normalizedEventName === 'cancelled') {
      const cancelledPayload = payload as ChatStreamCancelled
      conversationId = cancelledPayload.conversationId ?? conversationId
      handlers.onCancelled?.({
        conversationId,
        reason: cancelledPayload.reason,
        stage: cancelledPayload.stage,
      })
      cancelled = true
      return
    }

    if (normalizedEventName === 'done') {
      const completionPayload = payload as ChatStreamCompletion
      conversationId = completionPayload.conversationId ?? conversationId
      assistantMessageId = completionPayload.assistantMessageId ?? assistantMessageId
      agentId = completionPayload.agentId ?? agentId
      agentName = completionPayload.agentName ?? agentName
      answer = completionPayload.answer ?? answer
      citations = completionPayload.citations
      answerSegments = completionPayload.answerSegments
      suggestions = completionPayload.suggestions
      activitySummary = completionPayload.debug?.activitySummary
      activityTrace = completionPayload.debug?.activityTrace
      route = completionPayload.debug?.route
      ownership = completionPayload.ownership
      handlers.onDone?.({
        conversationId,
        assistantMessageId,
        agentId,
        agentName,
        answer,
        citations,
        answerSegments,
        suggestions,
        ownership,
        debug: completionPayload.debug,
        skill: completionPayload.skill,
      })
      return
    }

    if (normalizedEventName === 'suggestions') {
      const suggestionsPayload = payload as ChatStreamSuggestions
      conversationId = suggestionsPayload.conversationId ?? conversationId
      suggestions = suggestionsPayload.suggestions
      handlers.onSuggestions?.({
        conversationId,
        suggestions,
      })
      return
    }

    if (normalizedEventName === 'skill') {
      const skillPayload = payload as ChatStreamSkill
      conversationId = skillPayload.conversationId ?? conversationId
      handlers.onSkill?.({
        conversationId,
        skillName: skillPayload.skillName,
        phase: skillPayload.phase,
        display: skillPayload.display,
        localizedTitle: skillPayload.localizedTitle,
        receipt: skillPayload.receipt,
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
    agentId,
    agentName,
    route,
    answer,
    citations,
    answerSegments,
    suggestions,
    ownership,
    ...(activitySummary ? { activitySummary } : {}),
    ...(activityTrace ? { activityTrace } : {}),
  }
}
