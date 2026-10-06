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
