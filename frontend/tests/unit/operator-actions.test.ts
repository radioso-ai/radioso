import { describe, expect, it } from 'vitest'

import type { ConversationOperator, ConversationOwnership } from '@/lib/api-types'
import { conversationOwner, deriveOperatorActions, ownershipMenu } from '@/lib/operator-actions'

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
      owner: null,
      version: null,
    })
  })

  it('claims on send for an AI-owned conversation and keeps its version', () => {
    expect(deriveOperatorActions(ownership({ state: 'ai_owned', version: 4 }), 'user-me')).toMatchObject({
      status: 'ai_owned',
      claimsOnSend: true,
      canReply: true,
      version: 4,
    })
  })

  it('offers reply on a handoff waiting to be claimed', () => {
    expect(deriveOperatorActions(ownership({ state: 'human_owned', version: 5 }), 'user-me')).toEqual({
      status: 'awaiting_human',
      claimsOnSend: true,
      canReply: true,
      owner: null,
      version: 5,
    })
  })

  it('lets the owner reply without claiming again', () => {
    expect(deriveOperatorActions(ownedBy('user-me', 'Me Myself'), 'user-me')).toEqual({
      status: 'owned_by_me',
      claimsOnSend: false,
      canReply: true,
      owner: { userId: 'user-me', label: 'Me Myself' },
      version: 6,
    })
  })

  it('withholds the composer when a teammate owns the conversation', () => {
    expect(deriveOperatorActions(ownedBy('user-dana', 'Dana Scully'), 'user-me')).toEqual({
      status: 'owned_by_teammate',
      claimsOnSend: false,
      canReply: false,
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

  it('treats a handed-back record, which names no one, as AI-owned and claims it on send', () => {
    const handedBack = ownership({ state: 'ai_owned', ownerAccountId: null, ownerUserId: null, ownerDisplayName: null, version: 9 })

    expect(deriveOperatorActions(handedBack, 'user-me')).toEqual({
      status: 'ai_owned',
      claimsOnSend: true,
      canReply: true,
      owner: null,
      version: 9,
    })
  })

  it('withholds the composer from a held conversation until the signed-in user is known, whoever holds it', () => {
    expect(deriveOperatorActions(ownedBy('user-dana', 'Dana Scully'), null)).toEqual({
      status: 'owned_viewer_unknown',
      claimsOnSend: false,
      canReply: false,
      owner: { userId: 'user-dana', label: 'Dana Scully' },
      version: 6,
    })
    // Possibly my own: it must not read as a teammate's either.
    expect(deriveOperatorActions(ownedBy('user-me', 'Me Myself'), null).status).toBe('owned_viewer_unknown')
  })

  it('keeps claim-on-send for a conversation nobody holds while the signed-in user is unknown', () => {
    const claimsOnSend = { claimsOnSend: true, canReply: true, owner: null }

    expect(deriveOperatorActions(undefined, null)).toMatchObject({ status: 'ai_owned', ...claimsOnSend })
    expect(deriveOperatorActions(ownership({ state: 'ai_owned', version: 3 }), null)).toMatchObject({ status: 'ai_owned', ...claimsOnSend })
    expect(deriveOperatorActions(ownership({ state: 'human_owned', version: 3 }), null)).toMatchObject({ status: 'awaiting_human', ...claimsOnSend })
  })
})

describe('ownershipMenu', () => {
  const operators: ConversationOperator[] = [
    { userId: 'user-dana', label: 'Dana Scully' },
    { userId: 'user-me', label: 'Me Myself' },
    { userId: 'user-fox', label: 'fox@example.com' },
  ]
  const menuFor = (value: ConversationOwnership | undefined, currentUserId: string | null = 'user-me') =>
    ownershipMenu(deriveOperatorActions(value, currentUserId), operators, currentUserId)

  it('reassigns a teammate’s conversation to me first, then to anyone else but its owner', () => {
    expect(menuFor(ownedBy('user-dana', 'Dana Scully'))).toEqual({
      kind: 'reassign',
      targets: [
        { kind: 'me', userId: 'user-me' },
        { kind: 'teammate', userId: 'user-fox', label: 'fox@example.com' },
      ],
    })
  })

  it('reassigns my own conversation to every teammate but me, with no Me entry', () => {
    expect(menuFor(ownedBy('user-me', 'Me Myself'))).toEqual({
      kind: 'reassign',
      targets: [
        { kind: 'teammate', userId: 'user-dana', label: 'Dana Scully' },
        { kind: 'teammate', userId: 'user-fox', label: 'fox@example.com' },
      ],
    })
  })

  it('assigns a handoff nobody has claimed to me first, then to every teammate', () => {
    const expected = {
      kind: 'assign',
      targets: [
        { kind: 'me', userId: 'user-me' },
        { kind: 'teammate', userId: 'user-dana', label: 'Dana Scully' },
        { kind: 'teammate', userId: 'user-fox', label: 'fox@example.com' },
      ],
    }
    expect(menuFor(ownership({ state: 'human_owned' }))).toEqual(expected)
    // Claimed under organisation-level ownership: it names no user, so it waits for a teammate.
    expect(menuFor(ownedBy(null, 'Acme'))).toEqual(expected)
  })

  it('offers no menu while the agent owns the conversation', () => {
    expect(menuFor(undefined)).toBeNull()
    expect(menuFor(ownership({ state: 'ai_owned' }))).toBeNull()
  })

  it('offers Me before the teammate list loads, and nothing when there is no one to offer', () => {
    const teammateHeld = deriveOperatorActions(ownedBy('user-dana', 'Dana Scully'), 'user-me')
    expect(ownershipMenu(teammateHeld, [], 'user-me')).toEqual({
      kind: 'reassign',
      targets: [{ kind: 'me', userId: 'user-me' }],
    })
    const mine = deriveOperatorActions(ownedBy('user-me', 'Me Myself'), 'user-me')
    expect(ownershipMenu(mine, [{ userId: 'user-me', label: 'Me Myself' }], 'user-me')).toBeNull()
  })

  it('offers no menu while the signed-in teammate is unknown, since "Me" cannot be told from a teammate', () => {
    expect(menuFor(ownedBy('user-dana', 'Dana Scully'), null)).toBeNull()
    expect(menuFor(ownedBy('user-me', 'Me Myself'), null)).toBeNull()
    expect(menuFor(ownership({ state: 'human_owned' }), null)).toBeNull()
    expect(ownershipMenu({ status: 'owned_by_teammate', owner: { userId: 'user-dana', label: 'Dana Scully' } }, operators, null)).toBeNull()
  })
})
