import type { ConversationOperator, ConversationOwnership } from './api-types'

type OwnershipIdentity = Pick<ConversationOwnership, 'state' | 'ownerUserId' | 'ownerDisplayName'>

/**
 * The teammate holding a human-owned conversation. A conversation is claimed
 * exactly when it names a user; `userId` identifies the owner for "mine"
 * checks, grouping and filtering. `label` is the teammate label, null when
 * there is none.
 */
export interface ConversationOwner {
  userId: string
  label: string | null
}

export const conversationOwner = (ownership?: OwnershipIdentity | null): ConversationOwner | null => {
  if (!ownership || ownership.state !== 'human_owned' || !ownership.ownerUserId) {
    return null
  }
  return { userId: ownership.ownerUserId, label: ownership.ownerDisplayName?.trim() || null }
}

/**
 * `owned_viewer_unknown`: someone holds the conversation, but the signed-in teammate is not known
 * yet (auth still bootstrapping), so it can be neither "mine" nor a teammate's. It offers no
 * owner-specific action until the viewer is known.
 */
type OperatorActionStatus = 'ai_owned' | 'awaiting_human' | 'owned_by_me' | 'owned_by_teammate' | 'owned_viewer_unknown'

interface OperatorActions {
  status: OperatorActionStatus
  /** Sending claims the conversation: it is AI-owned or waits unclaimed. */
  claimsOnSend: boolean
  /** The reply composer shows: nobody holds the conversation, or I do. */
  canReply: boolean
  owner: ConversationOwner | null
  version: number | null
}

const statusFor = (
  ownership: ConversationOwnership | undefined,
  owner: ConversationOwner | null,
  currentUserId: string | null,
): OperatorActionStatus => {
  // A hand-back leaves an AI-owned record behind; it reads like no record at all.
  if (!ownership || ownership.state === 'ai_owned') {
    return 'ai_owned'
  }
  if (!owner) {
    return 'awaiting_human'
  }
  if (currentUserId === null) {
    return 'owned_viewer_unknown'
  }
  return owner.userId === currentUserId ? 'owned_by_me' : 'owned_by_teammate'
}

export const deriveOperatorActions = (
  ownership: ConversationOwnership | undefined,
  currentUserId: string | null,
): OperatorActions => {
  const owner = conversationOwner(ownership)
  const status = statusFor(ownership, owner, currentUserId)
  const claimsOnSend = status === 'ai_owned' || status === 'awaiting_human'
  return {
    status,
    claimsOnSend,
    canReply: claimsOnSend || status === 'owned_by_me',
    owner,
    version: ownership?.version ?? null,
  }
}

/** Who a human-owned conversation can go to: the signed-in teammate ("Me"), or another teammate. */
type OwnershipTarget =
  | { kind: 'me'; userId: string }
  | { kind: 'teammate'; userId: string; label: string }

/**
 * "Assign" places a handoff nobody has claimed; "Reassign" moves one someone holds. Both are a
 * transfer to the chosen teammate.
 */
interface OwnershipMenu {
  kind: 'assign' | 'reassign'
  targets: OwnershipTarget[]
}

const MENU_KIND: Record<OperatorActionStatus, OwnershipMenu['kind'] | null> = {
  ai_owned: null,
  awaiting_human: 'assign',
  owned_by_me: 'reassign',
  owned_by_teammate: 'reassign',
  owned_viewer_unknown: null,
}

/**
 * The ownership menu for a conversation, or null when it has none. An AI-owned conversation has
 * none: sending claims it. No conversation has one while the signed-in teammate is unknown, since
 * "Me" can't be told apart from the teammates yet. Otherwise "Me" comes first unless I
 * already hold it, then every other eligible teammate except whoever holds it now. "Me" does not
 * wait on the teammate list, so a teammate's conversation can be taken before the list loads.
 */
export const ownershipMenu = (
  actions: Pick<OperatorActions, 'status' | 'owner'>,
  operators: readonly ConversationOperator[],
  currentUserId: string | null,
): OwnershipMenu | null => {
  const kind = MENU_KIND[actions.status]
  if (!kind || currentUserId === null) {
    return null
  }
  const ownerUserId = actions.owner?.userId ?? null
  const me: OwnershipTarget[] = currentUserId !== ownerUserId
    ? [{ kind: 'me', userId: currentUserId }]
    : []
  const teammates: OwnershipTarget[] = operators
    .filter((operator) => operator.userId !== ownerUserId && operator.userId !== currentUserId)
    .map((operator) => ({ kind: 'teammate', userId: operator.userId, label: operator.label }))
  const targets = [...me, ...teammates]
  return targets.length > 0 ? { kind, targets } : null
}
