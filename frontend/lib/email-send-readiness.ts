import type { ConversationEmailFacts } from './api-email-channel'

/**
 * Why replies on an email conversation cannot be sent now, from the last read of its facts; null
 * only when that read succeeded and says the mailbox can send. Until the facts are read, or when
 * their last read failed and what is held may be stale, replies wait: a send nobody could check
 * is never offered.
 */
export const emailSendUnavailableReason = (read: {
  facts: ConversationEmailFacts | null
  error: string | null
}): string | null => {
  if (read.error) return 'Can’t confirm this mailbox can send right now.'
  if (!read.facts) return 'Checking whether this mailbox can send.'
  switch (read.facts.sending.state) {
    case 'not_verified':
      return 'Replies wait until this mailbox’s domain is verified.'
    case 'domain_removed':
      return 'This mailbox’s sending domain was removed.'
    default:
      return null
  }
}

/** What the Inbox has read of a conversation's channel: nothing yet, a failed read, or its provider. */
export type ConversationChannelRead =
  | { state: 'pending' }
  | { state: 'failed' }
  | { state: 'known'; provider: string | null }

/**
 * Why a reply on a conversation cannot be sent now; null once it can. Until the conversation's
 * channel is known nothing is offered, since only the channel says whether a reply can go out: an
 * email conversation then waits on its mailbox, and any other channel sends.
 */
export const conversationSendUnavailableReason = (
  channel: ConversationChannelRead,
  email: { facts: ConversationEmailFacts | null; error: string | null },
): string | null => {
  if (channel.state === 'pending') return 'Checking whether this conversation can send.'
  if (channel.state === 'failed') return 'Can’t confirm this conversation can send right now.'
  return channel.provider === 'email' ? emailSendUnavailableReason(email) : null
}
