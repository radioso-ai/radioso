import type { ChatConversationDetail } from '@/lib/api'

/**
 * Who a thread is shown to. Operators see the teammate who wrote a human reply; a visitor sees
 * only the reply's signature. Chosen by the surface rendering the thread, never inferred from
 * which fields a message happens to carry.
 */
export type ReplyAttributionAudience = 'operator' | 'visitor'

const GENERIC_TEAMMATE = 'A teammate'

const present = (value: string | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** The name on a human-agent reply's badge for this audience. */
export const humanReplyAuthor = (
  message: { operatorLabel?: string; operatorDisplayName?: string },
  audience: ReplyAttributionAudience,
): string => {
  const signature = present(message.operatorDisplayName)
  if (audience === 'visitor') {
    return signature ?? GENERIC_TEAMMATE
  }
  return present(message.operatorLabel) ?? signature ?? GENERIC_TEAMMATE
}

type ReplySource = ChatConversationDetail['messages'][number]['source']

/** Whether a person from the team wrote a message, in their own name or on the agent's behalf. */
export const isHumanAuthoredSource = (source: ReplySource | undefined): boolean =>
  source === 'human_agent' || source === 'human_agent_on_behalf_of_ai_agent'

/**
 * Whether a person from the team wrote the latest reply the visitor got. Visitors never receive
 * the conversation's ownership state, so the thread itself is the signal: a teammate counts as
 * present until the agent replies again. A reply still streaming or one that failed says nothing
 * about who is answering.
 */
export const teammateHasLatestReply = (
  messages: readonly { role: string; source?: ReplySource; status?: string }[],
): boolean => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.status !== 'streaming' && message.status !== 'error') {
      return isHumanAuthoredSource(message.source)
    }
  }
  return false
}
