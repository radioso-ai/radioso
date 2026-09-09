import type { ChatConversationTurn } from '@/lib/api'
import type { ChatMessage } from '@/lib/chat-context'
import { getPrimaryLeafTrace } from '@/lib/turn-trace'

type LiveTurnDiagnostics = {
  messageId: string
  activityTrace?: ChatMessage['activityTrace']
  turnTrace?: ChatMessage['turnTrace']
  answerCoverage?: ChatMessage['answerCoverage']
  interactionTrace?: ChatMessage['interactionTrace']
  errorMessage?: string
}

/** Preserves persisted history debug when a workbench adopts a conversation. */
export const historyTurnToChatMessage = (turn: ChatConversationTurn): ChatMessage => ({
  id: turn.id,
  role: turn.role === 'assistant' ? 'assistant' : 'user',
  content: turn.content,
  createdAt: turn.createdAt,
  citations: turn.citations,
  answerSegments: turn.answerSegments,
  persistedAssistantMessageId: turn.role === 'assistant' ? turn.id : undefined,
  turnTrace: turn.debug?.turnTrace,
  activityTrace: turn.debug?.activityTrace,
  answerCoverage: turn.debug?.answerCoverage,
  interactionTrace: turn.debug?.interactionTrace,
  status: 'complete',
})

/** Projects the selected live turn and its assistant diagnostics for the inspector. */
export const buildLiveTurnDiagnostics = (
  selected: ChatMessage | null,
  assistant: ChatMessage | null,
): LiveTurnDiagnostics | null => {
  if (!selected) return null
  const envelope = assistant?.turnTrace
  return {
    messageId: selected.id,
    activityTrace: getPrimaryLeafTrace(envelope) ?? assistant?.activityTrace,
    turnTrace: envelope,
    answerCoverage: assistant?.answerCoverage,
    interactionTrace: assistant?.interactionTrace,
    errorMessage: assistant?.status === 'error' ? assistant.content : undefined,
  }
}
