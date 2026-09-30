import { describe, expect, it } from 'vitest'

import type { ConversationOperator, ConversationOwnership } from '@/lib/api-types'
import { conversationOwner, deriveOperatorActions, listHandOffTargets } from '@/lib/operator-actions'

const ownership = (
  overrides: Partial<ConversationOwnership>,
): ConversationOwnership => ({
  conversationId: 'conversation-1',
  workspaceId: 'workspace-1',
  state: 'ai_owned',
  ownerAccountId: null,
  ownerUserId: null,
  ownerDisplayName: null,
  reason: null,
  version: 1,
  takenOverAt: null,
  createdAt: '2026-06-19T10:00:00.000Z',
  updatedAt: '2026-06-19T10:00:00.000Z',
  ...overrides,
})

const ownedBy = (userId: string | null, label: string | null, version = 6) => ownership({
  state: 'human_owned',
  ownerAccountId: 'account-1',
  ownerUserId: userId,
  ownerDisplayName: label,
  version,
})

describe('conversationOwner', () => {
  it('has no owner while AI-owned or waiting to be claimed', () => {
    expect(conversationOwner()).toBeNull()
    expect(conversationOwner(ownership({ state: 'ai_owned' }))).toBeNull()
    expect(conversationOwner(ownership({ state: 'human_owned' }))).toBeNull()
  })

  it('names the teammate by user, with a trimmed label', () => {
    expect(conversationOwner(ownedBy('user-dana', ' Dana Scully '))).toEqual({
      userId: 'user-dana',
      label: 'Dana Scully',
    })
    expect(conversationOwner(ownedBy('user-dana', null))).toEqual({ userId: 'user-dana', label: null })
  })

  it('has no owner when the ownership names no user, whatever else it carries', () => {
    expect(conversationOwner(ownedBy(null, 'Acme'))).toBeNull()
  })
})

describe('deriveOperatorActions', () => {
  it('claims on send when there is no ownership record', () => {
    expect(deriveOperatorActions(undefined, 'user-me')).toEqual({
      status: 'ai_owned',
      claimsOnSend: true,
      canReply: true,
      canHandOff: false,
      owner: null,
      version: null,
    })
  })

  it('claims on send for an AI-owned conversation and keeps its version, without offering a hand-off', () => {
    expect(deriveOperatorActions(ownership({ state: 'ai_owned', version: 4 }), 'user-me')).toMatchObject({
      status: 'ai_owned',
      claimsOnSend: true,
      canReply: true,
      canHandOff: false,
      version: 4,
    })
  })

  it('offers reply and hand-off on a handoff waiting to be claimed', () => {
    expect(deriveOperatorActions(ownership({ state: 'human_owned', version: 5 }), 'user-me')).toEqual({
      status: 'awaiting_human',
      claimsOnSend: true,
      canReply: true,
      canHandOff: true,
      owner: null,
      version: 5,
    })
  })

  it('lets the owner reply and hand off without claiming again', () => {
    expect(deriveOperatorActions(ownedBy('user-me', 'Me Myself'), 'user-me')).toEqual({
      status: 'owned_by_me',
      claimsOnSend: false,
      canReply: true,
      canHandOff: true,
      owner: { userId: 'user-me', label: 'Me Myself' },
      version: 6,
    })
  })

  it('withholds the composer when a teammate owns the conversation', () => {
    expect(deriveOperatorActions(ownedBy('user-dana', 'Dana Scully'), 'user-me')).toEqual({
      status: 'owned_by_teammate',
      claimsOnSend: false,
      canReply: false,
      canHandOff: false,
      owner: { userId: 'user-dana', label: 'Dana Scully' },
      version: 6,
    })
  })

  it('treats a human-owned conversation that names no user as waiting to be claimed', () => {
    expect(deriveOperatorActions(ownedBy(null, 'Acme'), 'user-me')).toMatchObject({
      status: 'awaiting_human',
      claimsOnSend: true,
      canReply: true,
      owner: null,
    })
  })

  it('treats every owned conversation as a teammate’s when the signed-in user is unknown', () => {
    expect(deriveOperatorActions(ownedBy('user-dana', 'Dana Scully'), null).status).toBe('owned_by_teammate')
  })
})

describe('listHandOffTargets', () => {
  const operators: ConversationOperator[] = [
    { userId: 'user-me', label: 'Me Myself' },
    { userId: 'user-dana', label: 'Dana Scully' },
    { userId: 'user-fox', label: 'fox@example.com' },
  ]

  it('offers every teammate but me when I own the conversation', () => {
    expect(listHandOffTargets(operators, ownedBy('user-me', 'Me Myself'))).toEqual([
      { userId: 'user-dana', label: 'Dana Scully' },
      { userId: 'user-fox', label: 'fox@example.com' },
    ])
  })

  it('offers every teammate, me included, while the handoff waits to be claimed', () => {
    expect(listHandOffTargets(operators, ownership({ state: 'human_owned' }))).toEqual(operators)
  })
})
