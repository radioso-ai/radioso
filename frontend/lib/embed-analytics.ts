export const WEBSITE_EMBED_ANALYTICS_MESSAGE = 'radioso:analytics'

export const websiteEmbedAnalyticsEventNames = [
  'website_embed.loaded',
  'chat.started',
  'chat.completed',
  'chat.failed',
] as const

export type WebsiteEmbedAnalyticsEventName = (typeof websiteEmbedAnalyticsEventNames)[number]
export type WebsiteEmbedAnalyticsSubjectType = 'embed_session' | 'conversation'
export type WebsiteEmbedAnalyticsPropertyValue = string | number | boolean | null

export interface WebsiteEmbedAnalyticsMessage {
  type: typeof WEBSITE_EMBED_ANALYTICS_MESSAGE
  event: WebsiteEmbedAnalyticsEventName
  timestamp: string
  source: 'embed'
  subjectType?: WebsiteEmbedAnalyticsSubjectType
  subjectId?: string
  properties?: Record<string, WebsiteEmbedAnalyticsPropertyValue>
}

export interface WebsiteEmbedAnalyticsInput {
  event: WebsiteEmbedAnalyticsEventName
  timestamp?: string
  subjectType?: WebsiteEmbedAnalyticsSubjectType
  subjectId?: string | null
  properties?: Record<string, unknown>
}

interface WebsiteEmbedPostWindow {
  parent: {
    postMessage: (message: WebsiteEmbedAnalyticsMessage, targetOrigin: string) => void
  }
}

const isSafePropertyValue = (value: unknown): value is WebsiteEmbedAnalyticsPropertyValue =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const sanitizeProperties = (
  properties: Record<string, unknown> | undefined,
): Record<string, WebsiteEmbedAnalyticsPropertyValue> | undefined => {
  if (!properties) {
    return undefined
  }

  const sanitized = Object.fromEntries(
    Object.entries(properties).filter(([, value]) => isSafePropertyValue(value)),
  ) as Record<string, WebsiteEmbedAnalyticsPropertyValue>

  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

export const buildWebsiteEmbedAnalyticsMessage = (
  input: WebsiteEmbedAnalyticsInput,
): WebsiteEmbedAnalyticsMessage => {
  const properties = sanitizeProperties(input.properties)

  return {
    type: WEBSITE_EMBED_ANALYTICS_MESSAGE,
    event: input.event,
    timestamp: input.timestamp ?? new Date().toISOString(),
    source: 'embed',
    ...(input.subjectType ? { subjectType: input.subjectType } : {}),
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(properties ? { properties } : {}),
  }
}

export const postWebsiteEmbedAnalyticsEvent = (
  input: WebsiteEmbedAnalyticsInput & { window?: WebsiteEmbedPostWindow },
): WebsiteEmbedAnalyticsMessage | null => {
  const targetWindow =
    input.window ??
    (typeof window === 'undefined' || window.parent === window
      ? null
      : window)

  if (!targetWindow) {
    return null
  }

  const message = buildWebsiteEmbedAnalyticsMessage(input)
  targetWindow.parent.postMessage(message, '*')
  return message
}
