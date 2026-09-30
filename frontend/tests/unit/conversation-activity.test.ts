import { describe, expect, it } from 'vitest'

import type { ConversationActivityEntry } from '@/lib/api-types'
import {
  activityLine,
  closedByLine,
  freshestActivity,
  handoffReasonLabel,
  placeActivity,
} from '@/lib/conversation-activity'

const bea = { userId: 'user-bea', label: 'Bea' }
const carl = { userId: 'user-carl', label: 'Carl' }

const entry = (overrides: Partial<ConversationActivityEntry>): ConversationActivityEntry => ({
  id: 'activity-1',
  kind: 'claimed',
  createdAt: '2026-09-30T10:00:00.000Z',
  actor: null,
  subject: null,
  from: null,
  handoffReason: null,
  decision: null,
  resolution: null,
  assistantMessageId: null,
  ...overrides,
})

describe('handoffReasonLabel', () => {
  it('names the handoff reasons the agent records', () => {
    expect(handoffReasonLabel('routine_handoff')).toBe('Routine asked for a person')
    expect(handoffReasonLabel('retrieval_miss')).toBe('No answer found')
    expect(handoffReasonLabel('operator_takeover')).toBe('Taken over by a teammate')
  })

  it('shows an unrecognised code readably rather than raw, and nothing for no reason', () => {
    expect(handoffReasonLabel('needs_operator')).toBe('Needs operator')
    expect(handoffReasonLabel('Visitor asked for the manager')).toBe('Visitor asked for the manager')
    expect(handoffReasonLabel(null)).toBeNull()
    expect(handoffReasonLabel('  ')).toBeNull()
  })
})

describe('activityLine', () => {
  it('says why the agent handed off', () => {
    expect(activityLine(entry({ kind: 'handoff_requested', handoffReason: 'retrieval_miss' }))).toBe('Handed off · No answer found')
    expect(activityLine(entry({ kind: 'handoff_requested' }))).toBe('Handed off')
  })

  it('names who took, assigned, reassigned, and handed back the conversation', () => {
    expect(activityLine(entry({ kind: 'claimed', actor: bea }))).toBe('Bea took this')
    expect(activityLine(entry({ kind: 'reassigned', actor: bea, subject: carl }))).toBe('Bea assigned this to Carl')
    expect(activityLine(entry({ kind: 'reassigned', actor: bea, subject: bea }))).toBe('Bea took this')
    expect(activityLine(entry({ kind: 'reassigned', actor: bea, subject: carl, from: bea }))).toBe('Bea reassigned this to Carl')
    expect(activityLine(entry({ kind: 'reassigned', actor: carl, subject: carl, from: bea }))).toBe('Carl took this from Bea')
    expect(activityLine(entry({ kind: 'handed_back', actor: carl }))).toBe('Carl handed this back to the agent')
  })

  it('names the approval option chosen and how feedback was closed', () => {
    expect(activityLine(entry({
      kind: 'approval_decided',
      actor: bea,
      decision: { optionId: 'approve', label: 'Approve refund' },
    }))).toBe('Bea decided · Approve refund')
    expect(activityLine(entry({ kind: 'feedback_resolved', actor: bea }))).toBe('Bea resolved the feedback')
    expect(activityLine(entry({ kind: 'feedback_dismissed', actor: carl }))).toBe('Carl dismissed the feedback')
  })

  it('never names the agent for a change only a person makes, when no teammate can be named', () => {
    expect(activityLine(entry({ kind: 'feedback_dismissed', actor: null }))).toBe('Someone dismissed the feedback')
    expect(activityLine(entry({ kind: 'handed_back', actor: { userId: 'user-gone', label: null } })))
      .toBe('A teammate handed this back to the agent')
    expect(activityLine(entry({ kind: 'reassigned', actor: bea, subject: { userId: 'user-gone', label: null } })))
      .toBe('Bea assigned this to a teammate')
  })
})

describe('placeActivity', () => {
  const messages = [
    { createdAt: '2026-09-30T10:00:00.000Z' },
    { createdAt: '2026-09-30T10:05:00.000Z' },
    { createdAt: undefined },
  ]

  it('places each event before the first message written after it, and later ones at the end', () => {
    const early = entry({ id: 'early', createdAt: '2026-09-30T09:59:00.000Z' })
    const between = entry({ id: 'between', createdAt: '2026-09-30T10:00:00.000Z' })
    const late = entry({ id: 'late', createdAt: '2026-09-30T10:06:00.000Z' })

    const placement = placeActivity(messages.slice(0, 2), [late, early, between], { hasOlderMessages: false })

    expect(placement.before.get(0)?.map((event) => event.id)).toEqual(['early'])
    expect(placement.before.get(1)?.map((event) => event.id)).toEqual(['between'])
    expect(placement.trailing.map((event) => event.id)).toEqual(['late'])
  })

  it('places an event after the settled messages but before a message still streaming', () => {
    const late = entry({ id: 'late', createdAt: '2026-09-30T10:06:00.000Z' })

    const placement = placeActivity(messages, [late], { hasOlderMessages: false })

    expect(placement.before.get(2)?.map((event) => event.id)).toEqual(['late'])
    expect(placement.trailing).toEqual([])
  })

  it('leaves out events older than the loaded window while older messages are unloaded', () => {
    const early = entry({ id: 'early', createdAt: '2026-09-30T09:59:00.000Z' })

    expect(placeActivity(messages, [early], { hasOlderMessages: true }).before.size).toBe(0)
    expect(placeActivity([], [early], { hasOlderMessages: false }).trailing.map((event) => event.id)).toEqual(['early'])
  })
})

describe('freshestActivity', () => {
  it('takes the longer read, since events are only ever added, preferring the tail on a tie', () => {
    const one = [entry({ id: 'a' })]
    const two = [entry({ id: 'a' }), entry({ id: 'b' })]

    expect(freshestActivity(two, one)).toBe(two)
    expect(freshestActivity(one, two)).toBe(two)
    expect(freshestActivity(one, [entry({ id: 'a' })])).not.toBe(one)
    expect(freshestActivity(undefined, undefined)).toEqual([])
  })
})

describe('closedByLine', () => {
  it('names who closed the item and when', () => {
    expect(closedByLine({ closedBy: bea }, '26 Sept, 4:40 PM')).toBe('Closed by Bea · 26 Sept, 4:40 PM')
    expect(closedByLine({ closedBy: null }, '26 Sept, 4:40 PM')).toBe('Closed · 26 Sept, 4:40 PM')
    expect(closedByLine({ closedBy: { userId: 'user-gone', label: null } }, 'now')).toBe('Closed by a teammate · now')
  })
})
