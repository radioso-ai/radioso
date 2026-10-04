import type { ConversationActivityEntry, ConversationActivityKind } from '@/lib/api-types'
import type { RecentlyClosedInboxItem } from '@/lib/needs-attention'

/**
 * Operator-only copy for a conversation's activity: the short lines the operator thread
 * interleaves with messages, and the "Closed by" line of the Inbox's recently-closed strip.
 * Teammates are named by teammate label, which can be an email, so none of this reaches a visitor.
 */

type ActivityPerson = ConversationActivityEntry['actor']

const HANDOFF_REASON_LABELS: Readonly<Record<string, string>> = {
  routine_handoff: 'Routine asked for a person',
  retrieval_miss: 'No answer found',
  operator_takeover: 'Taken over by a teammate',
}

// A reason code's shape (`needs_operator`), as against a reason already written in words.
const REASON_CODE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/

/**
 * A handoff reason as operators read it. An unrecognised code reads as words, never raw; a reason
 * already written in words is shown as it is.
 */
export const handoffReasonLabel = (reason: string | null | undefined): string | null => {
  const value = reason?.trim()
  if (!value) {
    return null
  }
  const known = HANDOFF_REASON_LABELS[value]
  if (known) {
    return known
  }
  if (!REASON_CODE.test(value)) {
    return value
  }
  const words = value.replace(/[_-]+/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// The agent acts only by handing off; every other kind is something a person does, so an event of
// those kinds with no teammate to name came from a caller that is no teammate (an API token), or a
// teammate since deleted — never the agent.
const AGENT_KINDS: ReadonlySet<ConversationActivityKind> = new Set(['handoff_requested'])

const actorName = (entry: ConversationActivityEntry): string => {
  if (!entry.actor) {
    return AGENT_KINDS.has(entry.kind) ? 'The agent' : 'Someone'
  }
  return entry.actor.label ?? 'A teammate'
}

const personName = (person: ActivityPerson): string => person?.label ?? 'a teammate'

const reassignmentLine = (entry: ConversationActivityEntry): string => {
  const actor = actorName(entry)
  const tookItThemselves = entry.actor !== null && entry.actor.userId === entry.subject?.userId
  if (!entry.from) {
    return tookItThemselves ? `${actor} took this` : `${actor} assigned this to ${personName(entry.subject)}`
  }
  return tookItThemselves
    ? `${actor} took this from ${personName(entry.from)}`
    : `${actor} reassigned this to ${personName(entry.subject)}`
}

/** One activity event as a short line in the operator thread. */
export const activityLine = (entry: ConversationActivityEntry): string => {
  switch (entry.kind) {
    case 'handoff_requested': {
      const reason = handoffReasonLabel(entry.handoffReason)
      return reason ? `Handed off · ${reason}` : 'Handed off'
    }
    case 'claimed':
      return `${actorName(entry)} took this`
    case 'reassigned':
      return reassignmentLine(entry)
    case 'handed_back':
      return `${actorName(entry)} handed this back to the agent`
    case 'approval_decided':
      return entry.decision ? `${actorName(entry)} decided · ${entry.decision.label}` : `${actorName(entry)} decided`
    case 'feedback_resolved':
      return `${actorName(entry)} resolved the feedback`
    case 'feedback_dismissed':
      return `${actorName(entry)} dismissed the feedback`
  }
}

/** What was closed, as the recently-closed strip labels it: the kind of item, and how it closed where that varies. */
export const recentlyClosedKindLabel = (
  item: Pick<RecentlyClosedInboxItem, 'itemKind' | 'outcome' | 'decisionLabel'>,
): string => {
  switch (item.itemKind) {
    case 'handoff':
      return 'Handoff'
    case 'approval':
      return item.decisionLabel ? `Approval · ${item.decisionLabel}` : 'Approval'
    case 'negative_feedback':
      return item.outcome === 'feedback_dismissed' ? 'Feedback dismissed' : 'Feedback resolved'
  }
}

/** The recently-closed strip's attribution line. */
export const closedByLine = (item: { closedBy: ActivityPerson }, when: string): string =>
  item.closedBy ? `Closed by ${personName(item.closedBy)} · ${when}` : `Closed · ${when}`

interface ActivityPlacement {
  /** Events to render just before the message at each index. */
  before: ReadonlyMap<number, ConversationActivityEntry[]>
  /** Events newer than every rendered message. */
  trailing: ConversationActivityEntry[]
}

const timeOf = (value: string | undefined): number => {
  const time = value ? new Date(value).getTime() : Number.NaN
  // A message still streaming has no timestamp yet: it is the newest thing in the thread.
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}

/**
 * Interleaves events with messages by time: each event goes before the first message written after
 * it. While older messages are not loaded, events older than the first loaded message are left
 * out, so they do not pile up above a window that starts mid-conversation.
 */
export const placeActivity = (
  messages: ReadonlyArray<{ createdAt?: string }>,
  activity: readonly ConversationActivityEntry[],
  options: { hasOlderMessages: boolean },
): ActivityPlacement => {
  const before = new Map<number, ConversationActivityEntry[]>()
  const trailing: ConversationActivityEntry[] = []
  const firstMessageTime = messages.length > 0 ? timeOf(messages[0].createdAt) : Number.POSITIVE_INFINITY
  const ordered = [...activity].sort((left, right) => timeOf(left.createdAt) - timeOf(right.createdAt))
  for (const event of ordered) {
    const eventTime = timeOf(event.createdAt)
    if (options.hasOlderMessages && eventTime < firstMessageTime) {
      continue
    }
    const index = messages.findIndex((message) => timeOf(message.createdAt) > eventTime)
    if (index === -1) {
      trailing.push(event)
      continue
    }
    before.set(index, [...(before.get(index) ?? []), event])
  }
  return { before, trailing }
}

/** Where the thread's day changes: the messages, by index, and the events, by id, a day label goes above. */
interface ThreadDayBreaks {
  messages: ReadonlySet<number>
  activity: ReadonlySet<string>
}

/**
 * Walks the thread in the order it renders — each message after the events placed before it, then
 * the trailing events — and marks every item whose day differs from the item just above it, so an
 * event sits under its own day rather than under the message before it. An item with no time yet
 * (a message still streaming) starts no day, and the item after it starts none either.
 */
export const threadDayBreaks = (
  messages: ReadonlyArray<{ createdAt?: string }>,
  placement: ActivityPlacement,
  dayOf: (createdAt: string) => string,
): ThreadDayBreaks => {
  const messageBreaks = new Set<number>()
  const activityBreaks = new Set<string>()
  let previousDay: string | null = null
  const startsDay = (createdAt: string | undefined): boolean => {
    const day = createdAt ? dayOf(createdAt) : null
    const changed = day !== null && previousDay !== null && day !== previousDay
    previousDay = day
    return changed
  }
  const walkEvents = (events: readonly ConversationActivityEntry[]) => {
    for (const event of events) {
      if (startsDay(event.createdAt)) {
        activityBreaks.add(event.id)
      }
    }
  }
  messages.forEach((message, index) => {
    walkEvents(placement.before.get(index) ?? [])
    if (startsDay(message.createdAt)) {
      messageBreaks.add(index)
    }
  })
  walkEvents(placement.trailing)
  return { messages: messageBreaks, activity: activityBreaks }
}

/**
 * A conversation's timeline from its two reads: the detail fetch, which reads the whole timeline,
 * and the events tail polls brought that it does not cover. The detail read is authoritative over
 * every event it holds, its teammate labels included; events of one millisecond keep the order they
 * were read in, which is the order they were recorded.
 */
export const mergeActivity = (
  detail: readonly ConversationActivityEntry[] | undefined,
  tail: readonly ConversationActivityEntry[],
): ConversationActivityEntry[] => {
  const detailIds = new Set((detail ?? []).map((event) => event.id))
  return [...(detail ?? []), ...tail.filter((event) => !detailIds.has(event.id))]
    .sort((left, right) => timeOf(left.createdAt) - timeOf(right.createdAt))
}

/** Whether two reads of a JSON value read the same. */
const sameJson = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true
  }
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    return false
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => sameJson(leftRecord[key], rightRecord[key]))
}

/**
 * The tail-held events with a poll's read folded in, oldest first: an event new to the reader is
 * added, and a held event read differently (a teammate relabelled) takes the new copy. A poll
 * re-reads a recent window, so it mostly repeats what is held — then `held` itself comes back.
 */
const withTailRead = (
  held: readonly ConversationActivityEntry[],
  read: readonly ConversationActivityEntry[],
): readonly ConversationActivityEntry[] => {
  const byId = new Map(held.map((event) => [event.id, event]))
  let changed = false
  for (const event of read) {
    const current = byId.get(event.id)
    if (!current || !sameJson(current, event)) {
      byId.set(event.id, event)
      changed = true
    }
  }
  return changed
    ? [...byId.values()].sort((left, right) => timeOf(left.createdAt) - timeOf(right.createdAt))
    : held
}

/**
 * The tail-held events a detail read does not cover: it read the whole timeline up to its newest
 * event, so the held events at or before that one are its to show or leave out — feedback the
 * reader may no longer see is left out of it. `held` itself comes back when none are covered.
 */
const withoutCoveredBy = (
  held: readonly ConversationActivityEntry[],
  detail: readonly ConversationActivityEntry[],
): readonly ConversationActivityEntry[] => {
  if (detail.length === 0) {
    return held
  }
  const coveredThrough = Math.max(...detail.map((event) => timeOf(event.createdAt)))
  const uncovered = held.filter((event) => timeOf(event.createdAt) > coveredThrough)
  return uncovered.length === held.length ? held : uncovered
}

/** What a reader holds of one conversation's timeline between renders. */
export interface ActivityTimelineState {
  conversationId: string | null
  /** The latest detail read, as last seen. */
  detail: readonly ConversationActivityEntry[] | undefined
  /** The latest poll's read, as last seen. */
  poll: readonly ConversationActivityEntry[] | undefined
  /** The events polls brought that no detail read covered when it arrived, oldest first. */
  tail: readonly ConversationActivityEntry[]
}

export const initialActivityTimeline = (conversationId: string | null): ActivityTimelineState => ({
  conversationId,
  detail: undefined,
  poll: undefined,
  tail: [],
})

/**
 * Folds the reads a render sees into what the reader holds. A detail read that arrives covers the
 * held events up to its newest one; a poll's read adds what it brings, even an event older than the
 * detail's newest, which a transaction can commit late. No poll empties the tail, and another
 * conversation starts over. Comes back as `state` itself when no read changed.
 */
export const reconcileActivityTimeline = (
  state: ActivityTimelineState,
  reads: Pick<ActivityTimelineState, 'conversationId' | 'detail' | 'poll'>,
): ActivityTimelineState => {
  let next = state.conversationId === reads.conversationId ? state : initialActivityTimeline(reads.conversationId)
  if (reads.detail !== next.detail) {
    next = {
      ...next,
      detail: reads.detail,
      tail: reads.detail ? withoutCoveredBy(next.tail, reads.detail) : next.tail,
    }
  }
  if (reads.poll !== next.poll) {
    next = { ...next, poll: reads.poll, tail: reads.poll ? withTailRead(next.tail, reads.poll) : [] }
  }
  return next
}
