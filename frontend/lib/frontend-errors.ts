export const frontendErrorTypes = [
  'frontend.react.unhandled',
  'frontend.runtime.unhandled',
  'frontend.promise.unhandled',
] as const

export type FrontendErrorType = (typeof frontendErrorTypes)[number]

export const FRONTEND_ERROR_MESSAGE_MAX_LENGTH = 2048
export const FRONTEND_ERROR_STACK_MAX_LENGTH = 16_384
export const FRONTEND_ERROR_COMPONENT_STACK_MAX_LENGTH = 8192
export const FRONTEND_ERROR_CLASS_MAX_LENGTH = 256

export interface FrontendErrorEvent {
  errorType: FrontendErrorType
  timestamp: string
  message: string
  errorClass?: string
  stack?: string
  componentStack?: string
  path?: string
  source?: 'frontend' | 'embed'
}

export interface FrontendErrorInput {
  errorType: FrontendErrorType
  error?: unknown
  message?: string
  errorClass?: string
  stack?: string
  componentStack?: string
  path?: string
  source?: FrontendErrorEvent['source']
}

export interface FrontendErrorSink {
  record(event: FrontendErrorEvent): Promise<void> | void
}

export interface FrontendErrorReporter {
  report(input: FrontendErrorInput): Promise<FrontendErrorEvent | null>
}

const truncate = (value: string | undefined, maxLength: number): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  return value.slice(0, maxLength)
}

export const sanitizeFrontendErrorPath = (path: string | undefined): string | undefined => {
  if (!path) {
    return undefined
  }

  let pathname = path.trim()
  try {
    pathname = new URL(pathname, globalThis.location?.origin ?? 'https://radioso.local').pathname
  } catch {
    pathname = pathname.split(/[?#]/u)[0]
  }

  const normalizedPathname = pathname.startsWith('/') ? pathname : `/${pathname}`
  return normalizedPathname
    .replace(/^\/invite\/[^/]+/u, '/invite/[token]')
    .replace(/^\/chat\/[^/]+/u, '/chat/[token]')
    .replace(/^\/embed\/[^/]+/u, '/embed/[token]')
    .replace(/^\/account\/[^/]+/u, '/account/[accountId]')
    .replace(/^\/w\/[^/]+/u, '/w/[workspaceKey]')
    .slice(0, 256)
}

// `error` here is whatever a caller threw, so it may be an object with no meaningful
// `toString` (default stringification renders "[object Object]" into the telemetry
// beacon). Serialize object-like throwables as JSON instead of relying on
// `String()`'s default coercion, keeping this a useful diagnostic message.
const stringifyThrowable = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'symbol' || typeof value === 'function') return value.toString()
  try {
    return JSON.stringify(value) ?? '[unserializable error]'
  } catch {
    return '[unserializable error]'
  }
}

export const serializeFrontendThrowable = (
  error: unknown,
): Pick<FrontendErrorEvent, 'errorClass' | 'message' | 'stack'> => {
  if (error instanceof Error) {
    return {
      errorClass: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  if (error === undefined || error === null) {
    return {
      message: 'Unknown frontend error',
    }
  }

  return {
    errorClass: typeof error,
    message: stringifyThrowable(error),
  }
}

export class NoopFrontendErrorSink implements FrontendErrorSink {
  async record(): Promise<void> {}
}

interface BeaconFrontendErrorSinkOptions {
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

export class BeaconFrontendErrorSink implements FrontendErrorSink {
  private readonly send: (url: string, body: string) => Promise<boolean> | boolean

  constructor(private readonly options: BeaconFrontendErrorSinkOptions) {
    this.send = options.send ?? defaultBeaconSend
  }

  async record(event: FrontendErrorEvent): Promise<void> {
    const delivered = await this.send(this.options.endpoint, JSON.stringify(event))

    if (!delivered) {
      throw new Error('frontend_error_delivery_failed')
    }
  }
}

interface FrontendErrorReporterOptions {
  enabled?: boolean
  now?: () => string
  sinks?: FrontendErrorSink[]
}

export const createFrontendErrorReporter = (
  options: FrontendErrorReporterOptions = {},
): FrontendErrorReporter => ({
  async report(input: FrontendErrorInput): Promise<FrontendErrorEvent | null> {
    if (options.enabled === false) {
      return null
    }

    const serialized = serializeFrontendThrowable(input.error)
    const event: FrontendErrorEvent = {
      errorType: input.errorType,
      timestamp: (options.now ?? (() => new Date().toISOString()))(),
      message: truncate(input.message ?? serialized.message, FRONTEND_ERROR_MESSAGE_MAX_LENGTH) ?? 'Unknown frontend error',
      errorClass: truncate(input.errorClass ?? serialized.errorClass, FRONTEND_ERROR_CLASS_MAX_LENGTH),
      stack: truncate(input.stack ?? serialized.stack, FRONTEND_ERROR_STACK_MAX_LENGTH),
      componentStack: truncate(input.componentStack, FRONTEND_ERROR_COMPONENT_STACK_MAX_LENGTH),
      path: sanitizeFrontendErrorPath(input.path),
      source: input.source ?? 'frontend',
    }

    await Promise.all((options.sinks ?? [new NoopFrontendErrorSink()]).map(async (sink) => {
      try {
        await sink.record(event)
      } catch {
        // Frontend error reporting is non-critical and must not trigger another user-visible failure.
      }
    }))

    return event
  },
})
