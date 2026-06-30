import type { ChatConversationDetail, ChatConversationTurn } from './api'
import type { EvalSnapshot } from './api-eval'
import type { WorkbenchSeedTurn } from '@/components/dashboard/workbench/use-workbench-state'

const snapshotMessageToTurn = (
  snapshot: EvalSnapshot,
  message: EvalSnapshot['messages'][number],
): ChatConversationTurn => ({
  id: message.id,
  role: message.role,
  source: message.role === 'assistant' ? 'ai_agent' : message.role === 'user' ? 'customer' : 'system',
  content: message.content,
  createdAt: message.createdAt,
  citations: message.citations,
  answerSegments: message.answerSegments,
} as ChatConversationTurn)

export const buildSnapshotConversation = (snapshot: EvalSnapshot): ChatConversationDetail => ({
  conversationId: snapshot.sourceConversationId,
  workspaceId: snapshot.workspaceId,
  agentId: snapshot.sourceAgentId,
  sourceChannel: null,
  sourceOrigin: null,
  channelContext: null,
  createdAt: snapshot.capturedAt,
  updatedAt: snapshot.capturedAt,
  messageCount: snapshot.messages.length,
  userMessageCount: snapshot.messages.filter((message) => message.role === 'user').length,
  assistantMessageCount: snapshot.messages.filter((message) => message.role === 'assistant').length,
  messagesTotal: snapshot.messages.length,
  messageWindowOffset: 0,
  messageWindowLimit: snapshot.messages.length,
  hasOlderMessages: false,
  nextCursor: null,
  tailCursor: null,
  messages: snapshot.messages.map((message) => snapshotMessageToTurn(snapshot, message)),
} as ChatConversationDetail)

const buildReplayTargetSeedTurn = (
  conversation: ChatConversationDetail,
  snapshot: EvalSnapshot,
): WorkbenchSeedTurn | null => {
  const replayTarget = snapshot.replayTarget
  if (!replayTarget) return null

  const userTurn = conversation.messages.find(
    (message) => message.id === replayTarget.userMessageId && message.role === 'user',
  )
  if (!userTurn) return null

  const assistantTurn = replayTarget.assistantMessageId
    ? conversation.messages.find(
      (message) => message.id === replayTarget.assistantMessageId && message.role === 'assistant',
    ) ?? null
    : null

  return { conversation, userTurn, assistantTurn }
}

export const buildEvalSeedTurn = (snapshot: EvalSnapshot): WorkbenchSeedTurn | null => {
  const conversation = buildSnapshotConversation(snapshot)
  const targetSeed = buildReplayTargetSeedTurn(conversation, snapshot)
  if (targetSeed) return targetSeed

  const messages = conversation.messages
  if (messages.length === 0) return null

  const selectedIndex = snapshot.sourceMessageId
    ? messages.findIndex((message) => message.id === snapshot.sourceMessageId)
    : -1
  const assistantIndex = selectedIndex >= 0 && messages[selectedIndex]?.role === 'assistant'
    ? selectedIndex
    : (() => {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'assistant') return index
      }
      return -1
    })()

  const assistantTurn = assistantIndex >= 0 ? messages[assistantIndex] : null
  const userSearchStart = assistantIndex >= 0 ? assistantIndex - 1 : messages.length - 1
  for (let index = userSearchStart; index >= 0; index -= 1) {
    const turn = messages[index]
    if (turn?.role === 'user') {
      return { conversation, userTurn: turn, assistantTurn }
    }
  }

  const firstUser = messages.find((message) => message.role === 'user')
  return firstUser ? { conversation, userTurn: firstUser, assistantTurn } : null
}
