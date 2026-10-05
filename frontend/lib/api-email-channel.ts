import { request } from './api-client'
import { withQuery } from './api-query'

export type EmailEngagementMode = 'operator_only' | 'draft' | 'auto'
type EmailMailboxReceivingState = 'waiting_for_first_message' | 'ok' | 'silent'
type EmailMailboxSendingState = 'ok' | 'not_verified' | 'domain_removed'
export type EmailSetupCheckStep = 'base' | 'plus_address'

export type EmailDnsRecord = {
  purpose: 'dkim' | 'spf' | 'return_path' | 'receiving_mx' | 'dmarc'
  type: 'TXT' | 'MX' | 'CNAME'
  name: string
  value: string
  priority?: number
  status: 'pending' | 'verified' | 'failed' | 'advisory'
}

export type EmailDomain = {
  id: string
  domain: string
  sending: { status: 'pending' | 'verified' | 'failed'; checkedAt: string | null }
  receiving: { status: 'not_requested' | 'pending' | 'verified' | 'failed'; checkedAt: string | null }
  records: EmailDnsRecord[]
}

export type EmailMailboxSetupCheck = {
  step: EmailSetupCheckStep
  startedAt: string
  status: 'waiting' | 'passed'
  passedAt: string | null
  /** The real address, or a plus-addressed variant of it for the `plus_address` step. */
  instructions: { sendTo: string }
}

export type EmailMailbox = {
  id: string
  address: string
  displayName: string
  agentId: string | null
  domainId: string
  /** `<relay token>@<inbound domain>`: where the customer's mail service forwards to. */
  relayAddress: string
  engagementMode: EmailEngagementMode
  enabled: boolean
  policyVersion: number
  threadSendBudget: number
  hourlyGenerationBudget: number
  threadContextMessages: number
  spamOptIn: boolean
  silenceThresholdHours: number
  receiving: { state: EmailMailboxReceivingState; lastReceivedAt: string | null }
  sending: { state: EmailMailboxSendingState }
  plusAddressVerified: boolean
  setupCheck: EmailMailboxSetupCheck | null
}

export type EmailChannelOverview = {
  /** Whether this deployment has an email provider and inbound domain. */
  configured: boolean
  inboundDomain: string | null
  /** Empty, with a null default, when the channel is not configured. */
  supportedModes: EmailEngagementMode[]
  defaultMode: EmailEngagementMode | null
  domains: EmailDomain[]
  mailboxes: EmailMailbox[]
}

type CreateEmailMailboxRequest = {
  address: string
  displayName: string
  agentId?: string | null
  engagementMode?: EmailEngagementMode
}

type EmailMailboxLimits = Pick<
  EmailMailbox,
  'threadSendBudget' | 'hourlyGenerationBudget' | 'threadContextMessages' | 'spamOptIn' | 'silenceThresholdHours'
>

/** A settings change; `expectedPolicyVersion` refuses it when someone saved the mailbox since it was read. */
export type UpdateEmailMailboxRequest = Partial<EmailMailboxLimits> & {
  engagementMode?: EmailEngagementMode
  /** The owner's explicit opt-in; switching an existing mailbox to `auto` is refused without it. */
  autoOptIn?: true
  expectedPolicyVersion?: number
}

export type EmailEvent = {
  id: string
  createdAt: string
  state: 'pending' | 'fetched' | 'ingested' | 'done' | 'failed'
  classification: string | null
  disposition: 'ingest_only' | 'run_review_turn' | 'drop' | null
  reason: string | null
  sender: { address: string | null; displayName: string | null }
  subject: string | null
  auth: { spf: string; dkim: string; dmarc: string }
  spamVerdict: 'spam' | 'not_spam' | 'unknown'
  conversationId: string | null
  threadConflict: boolean
  hasRaw: boolean
  retryable: boolean
}

type EmailEventPage = { items: EmailEvent[]; nextCursor: string | null }

export type EmailRawMessageView = {
  /** A display-safe subset of the headers; never relay or thread tokens. */
  headers: { name: string; value: string }[]
  text: string | null
  sanitizedHtml: string | null
  truncated: boolean
  attachments: { name: string; contentType: string; sizeBytes: number }[]
}

export type ConversationEmailFacts = {
  mailbox: { id: string; address: string; displayName: string; engagementMode: EmailEngagementMode }
  participant: { address: string; displayName: string | null }
  latest: { subject: string | null; cc: string[]; inboundAt: string | null }
  sending: { state: EmailMailboxSendingState }
  sendBudget: { used: number; limit: number; renewedAt: string | null }
  messages: {
    messageId: string
    direction: 'inbound' | 'outbound'
    subject: string | null
    cc: string[]
    attachments: { name: string; contentType: string; sizeBytes: number }[]
    delivery: {
      state: 'queued' | 'accepted' | 'delivered' | 'bounced' | 'failed' | 'uncertain' | 'halted'
      failureCode: string | null
    } | null
    rawDeliveryId: string | null
  }[]
}

const channelPath = (workspaceId: string, suffix = '') =>
  `/workspaces/${encodeURIComponent(workspaceId)}/email-channel${suffix}`

const mailboxPath = (workspaceId: string, mailboxId: string, suffix = '') =>
  channelPath(workspaceId, `/mailboxes/${encodeURIComponent(mailboxId)}${suffix}`)

const domainPath = (workspaceId: string, domainId: string, suffix = '') =>
  channelPath(workspaceId, `/domains/${encodeURIComponent(domainId)}${suffix}`)

const eventPath = (workspaceId: string, deliveryId: string, suffix: string) =>
  channelPath(workspaceId, `/events/${encodeURIComponent(deliveryId)}${suffix}`)

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

export const emailChannelApi = {
  getOverview(workspaceId: string): Promise<EmailChannelOverview> {
    return request<EmailChannelOverview>(channelPath(workspaceId), { method: 'GET' })
  },

  createMailbox(workspaceId: string, body: CreateEmailMailboxRequest): Promise<EmailMailbox> {
    return request<EmailMailbox>(channelPath(workspaceId, '/mailboxes'), post(body))
  },

  getMailbox(workspaceId: string, mailboxId: string): Promise<EmailMailbox> {
    return request<EmailMailbox>(mailboxPath(workspaceId, mailboxId), { method: 'GET' })
  },

  updateMailbox(workspaceId: string, mailboxId: string, body: UpdateEmailMailboxRequest): Promise<EmailMailbox> {
    return request<EmailMailbox>(mailboxPath(workspaceId, mailboxId), { method: 'PATCH', body: JSON.stringify(body) })
  },

  startSetupCheck(workspaceId: string, mailboxId: string, step: EmailSetupCheckStep): Promise<EmailMailboxSetupCheck> {
    return request<EmailMailboxSetupCheck>(mailboxPath(workspaceId, mailboxId, '/setup-check'), post({ step }))
  },

  listEvents(workspaceId: string, mailboxId: string, query: { cursor?: string | null; limit?: number } = {}): Promise<EmailEventPage> {
    return request<EmailEventPage>(
      withQuery(mailboxPath(workspaceId, mailboxId, '/events'), { cursor: query.cursor, limit: query.limit }),
      { method: 'GET' },
    )
  },

  retryEvent(workspaceId: string, deliveryId: string): Promise<EmailEvent> {
    return request<EmailEvent>(eventPath(workspaceId, deliveryId, '/retry'), post())
  },

  getRawMessage(workspaceId: string, deliveryId: string): Promise<EmailRawMessageView> {
    return request<EmailRawMessageView>(eventPath(workspaceId, deliveryId, '/raw'), { method: 'GET' })
  },

  addDomain(workspaceId: string, domain: string): Promise<EmailDomain> {
    return request<EmailDomain>(channelPath(workspaceId, '/domains'), post({ domain }))
  },

  verifyDomain(workspaceId: string, domainId: string): Promise<EmailDomain> {
    return request<EmailDomain>(domainPath(workspaceId, domainId, '/verify'), post())
  },

  /** `confirmation` must equal the domain: direct receiving routes all of the domain's mail to Radioso. */
  enableDirectReceiving(workspaceId: string, domainId: string, confirmation: string): Promise<EmailDomain> {
    return request<EmailDomain>(domainPath(workspaceId, domainId, '/receiving'), post({ confirmation }))
  },

  getConversationFacts(conversationId: string, signal?: AbortSignal): Promise<ConversationEmailFacts> {
    return request<ConversationEmailFacts>(
      `/conversations/${encodeURIComponent(conversationId)}/email`,
      { method: 'GET', ...(signal ? { signal } : {}) },
    )
  },
}
