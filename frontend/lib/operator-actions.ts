import type { ConversationOperator, ConversationOwnership } from './api-types'

type OwnershipIdentity = Pick<ConversationOwnership, 'state' | 'ownerAccountId' | 'ownerUserId' | 'ownerDisplayName'>

/**
 * Who holds a human-owned conversation. `key` identifies the owner for
 * grouping and filtering: the user id, or the label for a conversation claimed
 * before ownership named a person (`userId` null) — such a conversation is
 * never "mine". `label` is the teammate label, null when there is none.
 */
export interface ConversationOwner {
  key: string
  userId: string | null
  label: string | null
}

export const conversationOwner = (ownership?: OwnershipIdentity | null): ConversationOwner | null => {
  if (!ownership || ownership.state !== 'human_owned') {
    return null
  }
  if (ownership.ownerUserId === null && ownership.ownerAccountId === null) {
    return null
  }
  const label = ownership.ownerDisplayName?.trim() || null
  return ownership.ownerUserId !== null
    ? { key: ownership.ownerUserId, userId: ownership.ownerUserId, label }
    : { key: `label:${label ?? ''}`, userId: null, label }
}

type OperatorActionStatus = 'ai_owned' | 'awaiting_human' | 'owned_by_me' | 'owned_by_teammate'

interface OperatorActions {
  status: OperatorActionStatus
  /** Sending takes the conversation first: it is AI-owned or waits unclaimed. */
  claimsOnSend: boolean
  /** The reply composer shows. A teammate's conversation must be taken over first. */
  canReply: boolean
  /** "Hand to…" applies: a handoff waiting to be claimed, or one the operator holds. */
  canHandOff: boolean
  owner: ConversationOwner | null
  version: number | null
}

const statusFor = (
  ownership: ConversationOwnership | undefined,
  owner: ConversationOwner | null,
  currentUserId: string | null,
): OperatorActionStatus => {
  if (!ownership || ownership.state === 'ai_owned') {
    return 'ai_owned'
  }
  if (!owner) {
    return 'awaiting_human'
  }
  return owner.userId !== null && owner.userId === currentUserId ? 'owned_by_me' : 'owned_by_teammate'
}

export const deriveOperatorActions = (
  ownership: ConversationOwnership | undefined,
  currentUserId: string | null,
): OperatorActions => {
  const owner = conversationOwner(ownership)
  const status = statusFor(ownership, owner, currentUserId)
  return {
    status,
    claimsOnSend: status === 'ai_owned' || status === 'awaiting_human',
    canReply: status !== 'owned_by_teammate',
    canHandOff: status === 'awaiting_human' || status === 'owned_by_me',
    owner,
    version: ownership?.version ?? null,
  }
}

/** The teammates a conversation can be handed to: everyone but whoever holds it now. */
export const listHandOffTargets = (
  operators: readonly ConversationOperator[],
  ownership?: Pick<ConversationOwnership, 'ownerUserId'> | null,
): ConversationOperator[] => operators.filter((operator) => operator.userId !== ownership?.ownerUserId)
