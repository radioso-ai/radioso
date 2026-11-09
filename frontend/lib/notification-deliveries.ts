// What happened to each address of each notice, as GET /notification-deliveries reports it.

const notificationDeliveryKinds = ['contact_request', 'approval', 'handoff', 'completion'] as const
const notificationDeliveryOutcomes = [
  'sent',
  'skipped_unconfirmed',
  'skipped_revoked',
  'skipped_suppressed',
  'skipped_cap',
  'not_dispatched',
  'failed',
] as const

type NotificationDeliveryKind = (typeof notificationDeliveryKinds)[number]
export type NotificationDeliveryOutcome = (typeof notificationDeliveryOutcomes)[number]

export interface NotificationDelivery {
  id: string
  agentId: string | null
  conversationId: string
  kind: NotificationDeliveryKind
  recipientEmail: string
  outcome: NotificationDeliveryOutcome
  /** When the notice was first handled. */
  createdAt: string
  updatedAt: string
}

export interface NotificationDeliveryPage {
  items: NotificationDelivery[]
  nextCursor: string | null
}

export const NOTIFICATION_DELIVERY_KIND_LABELS: Record<NotificationDeliveryKind, string> = {
  contact_request: 'Contact request',
  approval: 'Approval',
  handoff: 'Hand-off',
  completion: 'Completion',
}

export const NOTIFICATION_DELIVERY_OUTCOME_LABELS: Record<NotificationDeliveryOutcome, string> = {
  sent: 'Sent',
  skipped_unconfirmed: 'Not sent: not confirmed',
  skipped_revoked: 'Not sent: stopped by the recipient',
  skipped_suppressed: 'Not sent: bounced or reported as spam',
  skipped_cap: 'Not sent: limit reached',
  not_dispatched: 'Not sent: email delivery is off',
  failed: 'Failed',
}

/** Only an address that has not confirmed can be asked again; the other skips are the recipient's or the platform's. */
export const canResendConfirmation = (outcome: NotificationDeliveryOutcome): boolean => outcome === 'skipped_unconfirmed'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const parseDelivery = (value: unknown): NotificationDelivery => {
  if (!isRecord(value)) throw new Error('A notification delivery must be an object.')
  const { id, agentId, conversationId, kind, recipientEmail, outcome, createdAt, updatedAt } = value
  if (typeof id !== 'string' || typeof conversationId !== 'string' || typeof recipientEmail !== 'string') {
    throw new Error('A notification delivery is missing its ids or recipient.')
  }
  if (agentId !== null && typeof agentId !== 'string') throw new Error('A notification delivery has an invalid agent.')
  if (!notificationDeliveryKinds.includes(kind as NotificationDeliveryKind)) throw new Error('A notification delivery has an unknown kind.')
  if (!notificationDeliveryOutcomes.includes(outcome as NotificationDeliveryOutcome)) throw new Error('A notification delivery has an unknown outcome.')
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') throw new Error('A notification delivery is missing its times.')
  return {
    id,
    agentId,
    conversationId,
    kind: kind as NotificationDeliveryKind,
    recipientEmail,
    outcome: outcome as NotificationDeliveryOutcome,
    createdAt,
    updatedAt,
  }
}

export const parseNotificationDeliveryPage = (payload: unknown): NotificationDeliveryPage => {
  if (!isRecord(payload) || !Array.isArray(payload.items)) throw new Error('Notification deliveries must be a page of items.')
  const { nextCursor } = payload
  if (nextCursor !== null && typeof nextCursor !== 'string') throw new Error('Notification deliveries have an invalid cursor.')
  return { items: payload.items.map(parseDelivery), nextCursor }
}

/** Appends a further page, dropping any row the first page already holds. */
export const appendNotificationDeliveryPage = (
  current: readonly NotificationDelivery[],
  next: readonly NotificationDelivery[],
): NotificationDelivery[] => {
  const seen = new Set(current.map((item) => item.id))
  return [...current, ...next.filter((item) => !seen.has(item.id))]
}
