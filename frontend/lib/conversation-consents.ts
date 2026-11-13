import { getApiErrorCode, getApiErrorDetails } from './api-error'
import type { ChatConversationMessage, ConversationConsent } from './api-types'

/** How a consent record stands: granted and in force, declined, or withdrawn after a grant. */
export type ConsentStatus = 'granted' | 'declined' | 'withdrawn'

export const consentStatus = (consent: ConversationConsent): ConsentStatus =>
  consent.withdrawnAt ? 'withdrawn' : consent.decision

/** Only a grant still in force can be withdrawn; a decline collected nothing. */
export const canWithdrawConsent = (consent: ConversationConsent): boolean => consentStatus(consent) === 'granted'

/** The list with `updated` in place of the record of the same id. */
export const withConsent = (consents: readonly ConversationConsent[], updated: ConversationConsent): ConversationConsent[] =>
  consents.map((consent) => (consent.id === updated.id ? updated : consent))

const isConsent = (value: unknown): value is ConversationConsent =>
  typeof value === 'object'
  && value !== null
  && typeof (value as { id?: unknown }).id === 'string'
  && typeof (value as { decision?: unknown }).decision === 'string'

/**
 * The record as it stands, read from a refused withdrawal (409 `consent_not_withdrawable`): it was
 * declined, or someone withdrew it first. Null for any other error.
 */
export const consentAfterRefusedWithdrawal = (error: unknown): ConversationConsent | null => {
  if (getApiErrorCode(error) !== 'consent_not_withdrawable') return null
  const details = getApiErrorDetails(error)
  const consent = typeof details === 'object' && details !== null ? (details as { consent?: unknown }).consent : undefined
  return isConsent(consent) ? consent : null
}

/** What the thread shows in place of a withheld message's redaction marker. */
export const WITHHELD_MESSAGE_LABEL = 'Withheld after consent was withdrawn'

/** A withheld message as the operator's thread shows it; any other message unchanged. */
export const withheldMessageView = <T extends Pick<ChatConversationMessage, 'content' | 'withheld'>>(message: T): T =>
  message.withheld ? { ...message, content: WITHHELD_MESSAGE_LABEL } : message
