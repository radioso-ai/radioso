import type { ConversationOwnership } from './api-types'

export type OperatorActionStatus = 'ai_owned' | 'awaiting_human' | 'human_owned'

export interface OperatorActions {
  canTakeOver: boolean
  canReply: boolean
  canHandBack: boolean
  status: OperatorActionStatus
  ownerLabel: string | null
  version: number | null
}

export const deriveOperatorActions = (ownership?: ConversationOwnership): OperatorActions => {
  if (!ownership || ownership.state === 'ai_owned') {
    return {
      canTakeOver: true,
      canReply: false,
      canHandBack: false,
      status: 'ai_owned',
      ownerLabel: null,
      version: ownership?.version ?? null,
    }
  }

  if (ownership.ownerAccountId === null) {
    return {
      canTakeOver: true,
      canReply: true,
      canHandBack: true,
      status: 'awaiting_human',
      ownerLabel: null,
      version: ownership.version,
    }
  }

  return {
    canTakeOver: false,
    canReply: true,
    canHandBack: true,
    status: 'human_owned',
    ownerLabel: ownership.ownerDisplayName ?? 'A teammate',
    version: ownership.version,
  }
}
