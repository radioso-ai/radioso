import type { components } from '../../../typescript-sdk/src/generated/types'

type PublicChatRequest = components['schemas']['PublicChatRequest']

/**
 * A key maps to `true` only while the backend takes the field absent but not `null`. The relay
 * leaves a `null` out (see below), which is right only for such a field, so a top-level field the
 * backend makes nullable turns its entry into `never` and fails `tsc` until the null rule is revisited.
 */
type RelayedFieldPolicy = { [K in keyof PublicChatRequest]-?: null extends PublicChatRequest[K] ? never : true }

/**
 * Every field the backend's public chat message schema accepts. The relay is an allow-list: only
 * these keys travel from a page to the backend. Typing it over the generated request keeps it
 * complete in both directions, so a field the backend gains fails `tsc` here until it is listed,
 * and a field the backend drops cannot linger.
 */
const RELAYED_FIELDS = {
  message: true,
  imageIds: true,
  stream: true,
  conversationId: true,
  bootstrapGreetingId: true,
  startConversation: true,
  userExpectedLocale: true,
  pageContext: true,
  clientContextCapabilities: true,
  signedIdentity: true,
  privacyNoticeVersion: true,
  inputMetadata: true,
} as const satisfies RelayedFieldPolicy

/** The names older embeds send for a field, read when the current name is absent. */
const OLDER_NAMES: Partial<Record<keyof PublicChatRequest, string>> = {
  message: 'query',
  startConversation: 'bootstrapGreeting',
}

const RELAYED_FIELD_NAMES = Object.keys(RELAYED_FIELDS) as Array<keyof PublicChatRequest>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The body for `POST /api/v1/public/chat/:token`, built from what a page sent. A page sends `null`
 * for a value it does not have, such as the embed frame's `signedIdentity` for a visitor the site
 * has not identified; the backend schema takes such a field absent, so null is left out.
 */
export const buildPublicChatMessageBody = (pageBody: unknown): Record<string, unknown> => {
  const incoming = isRecord(pageBody) ? pageBody : {}
  const body: Record<string, unknown> = {}
  for (const field of RELAYED_FIELD_NAMES) {
    const olderName = OLDER_NAMES[field]
    const value = incoming[field] ?? (olderName ? incoming[olderName] : undefined)
    if (value !== null && value !== undefined) body[field] = value
  }
  return body
}
