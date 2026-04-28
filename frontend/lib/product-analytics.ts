export const frontendProductAnalyticsEventNames = [
  'chat.citation_clicked',
  'website_embed.loaded',
] as const

export type FrontendProductAnalyticsEventName = (typeof frontendProductAnalyticsEventNames)[number]

export interface FrontendProductAnalyticsEvent {
  eventName: FrontendProductAnalyticsEventName
  timestamp: string
  workspaceId?: string
  accountId?: string
  actorType?: 'operator' | 'authenticated_user' | 'anonymous_user' | 'system'
  subjectType?: 'workspace' | 'document' | 'conversation' | 'settings' | 'embed_session'
  subjectId?: string
  properties?: Record<string, unknown>
  source?: 'frontend' | 'embed'
}

export interface FrontendProductAnalyticsSink {
  emit(event: FrontendProductAnalyticsEvent): Promise<void> | void
}

export interface FrontendProductAnalyticsInput {
  eventName: FrontendProductAnalyticsEventName
  workspaceId?: string
  accountId?: string
  actorType?: FrontendProductAnalyticsEvent['actorType']
  subjectType?: FrontendProductAnalyticsEvent['subjectType']
  subjectId?: string
  properties?: Record<string, unknown>
  source?: FrontendProductAnalyticsEvent['source']
}

export class NoopFrontendProductAnalyticsSink implements FrontendProductAnalyticsSink {
  async emit(): Promise<void> {}
}

interface BeaconSinkOptions {
  endpoint: string
  send?: (url: string, body: string) => Promise<boolean> | boolean
}

const defaultBeaconSend = async (url: string, body: string): Promise<boolean> => {
  const navigatorLike = (globalThis as { navigator?: { sendBeacon?: (targetUrl: string, data: Blob) => boolean } }).navigator

  if (navigatorLike?.sendBeacon) {
    return navigatorLike.sendBeacon(url, new Blob([body], { type: 'application/json' }))
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body,
    keepalive: true,
  })

  return response.ok
}

export class BeaconFrontendProductAnalyticsSink implements FrontendProductAnalyticsSink {
  private readonly send: (url: string, body: string) => Promise<boolean> | boolean

  constructor(private readonly options: BeaconSinkOptions) {
    this.send = options.send ?? defaultBeaconSend
  }

  async emit(event: FrontendProductAnalyticsEvent): Promise<void> {
    const delivered = await this.send(this.options.endpoint, JSON.stringify(event))

    if (!delivered) {
      throw new Error('frontend_product_analytics_delivery_failed')
    }
  }
}

interface FrontendProductAnalyticsEmitterOptions {
  enabled?: boolean
  now?: () => string
  sinks?: FrontendProductAnalyticsSink[]
}

export const createFrontendProductAnalyticsEmitter = (
  options: FrontendProductAnalyticsEmitterOptions = {},
) => ({
  async track(input: FrontendProductAnalyticsInput): Promise<FrontendProductAnalyticsEvent | null> {
    if (options.enabled === false) {
      return null
    }

    const event: FrontendProductAnalyticsEvent = {
      eventName: input.eventName,
      timestamp: (options.now ?? (() => new Date().toISOString()))(),
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      actorType: input.actorType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      properties: input.properties,
      source: input.source ?? 'frontend',
    }

    await Promise.all((options.sinks ?? [new NoopFrontendProductAnalyticsSink()]).map(async (sink) => {
      try {
        await sink.emit(event)
      } catch {
        // Frontend analytics is non-critical and should never affect UX.
      }
    }))

    return event
  },
})
