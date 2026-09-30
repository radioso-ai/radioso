import type { ConversationActivityEntry, ConversationActivityKind } from '@/lib/api-types'

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

/**
 * A conversation's timeline from every read of it: the detail fetch, and the tail polls — the first
 * reads the whole timeline, each later one only what was recorded since. Events are only ever
 * added, so the union by id, oldest first, is the timeline. A later read of an event replaces an
 * earlier one, its teammate labels being the fresher; events of one millisecond keep the order they
 * were read in, which is the order they were recorded.
 */
export const mergeActivity = (
  ...reads: ReadonlyArray<readonly ConversationActivityEntry[] | undefined>
): ConversationActivityEntry[] => {
  const byId = new Map<string, ConversationActivityEntry>()
  for (const read of reads) {
    for (const event of read ?? []) {
      byId.set(event.id, event)
    }
  }
  return [...byId.values()].sort((left, right) => timeOf(left.createdAt) - timeOf(right.createdAt))
}
