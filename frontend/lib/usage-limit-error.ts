import { getApiErrorCode, getApiErrorDetails } from './api-error'

/** Mirrors the EE backend's `UsageLimitExceededError` details shape (`ee/packages/backend-module/src/usageLimits/errors.ts`). */
export type UsageLimitResource =
  | 'monthly_answers'
  | 'monthly_conversations'
  | 'stored_documents'
  | 'stored_indexed_bytes'
  | 'monthly_indexed_bytes'

export interface UsageLimitNotice {
  /** `null` when the server reports a resource this build does not recognize yet. */
  resource: UsageLimitResource | null
  message: string
}

const USAGE_LIMIT_EXCEEDED_CODE = 'usage_limit_exceeded'

const MESSAGE_BY_RESOURCE: Record<UsageLimitResource, string> = {
  monthly_conversations: "This month's conversations are used up.",
  monthly_answers: "This month's conversations are used up.",
  stored_documents: "Your plan's document limit is reached.",
  stored_indexed_bytes: "Your plan's storage is full.",
  monthly_indexed_bytes: "This month's indexing allowance is used up.",
}

const GENERIC_MESSAGE = "Your plan's usage limit is reached."

const isKnownResource = (value: unknown): value is UsageLimitResource =>
  typeof value === 'string' && value in MESSAGE_BY_RESOURCE

const resourceOf = (details: unknown): unknown =>
  details && typeof details === 'object' && 'resource' in details
    ? (details as { resource?: unknown }).resource
    : undefined

/**
 * Recognizes a usage-limit error by its structured `code` (never by message text, which is
 * English and not meant to be parsed) and turns it into a short, resource-specific sentence
 * operators can act on. Returns `null` for every other error, including other 429s.
 */
export function getUsageLimitNotice(error: unknown): UsageLimitNotice | null {
  if (getApiErrorCode(error) !== USAGE_LIMIT_EXCEEDED_CODE) return null

  const resource = resourceOf(getApiErrorDetails(error))
  if (isKnownResource(resource)) {
    return { resource, message: MESSAGE_BY_RESOURCE[resource] }
  }
  return { resource: null, message: GENERIC_MESSAGE }
}

/**
 * Recognizes the usage-limit code on an event that carries no `details` at all. Test Chat's
 * per-side `side_failed` SSE event (`backend/src/modules/test-execution/testExecution.ts`)
 * reserves usage after the HTTP response has already started streaming, so exhaustion arrives as
 * a bare `code`, never the 429 body `getUsageLimitNotice` reads. That reservation is always an
 * answer/conversation spend, never storage, so this always returns the conversations sentence.
 */
export function getUsageLimitNoticeForCode(code: string): UsageLimitNotice | null {
  if (code !== USAGE_LIMIT_EXCEEDED_CODE) return null
  return { resource: 'monthly_conversations', message: MESSAGE_BY_RESOURCE.monthly_conversations }
}
