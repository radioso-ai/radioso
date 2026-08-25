import {
  BROWSER_FRAME_MAX_BYTES,
  decodeBrowserEventFrame,
  type BrowserEventFrame,
} from '@radioso/workspace-invalidation-contract'

const EVENTS_ENDPOINT = '/backend/api/v1/events'
const MIN_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000
const MAX_BROWSER_TIMER_MS = 2_147_483_647
const DEFAULT_STABLE_READY_MS = 5_000

export type WorkspaceEventsClientState = 'opened' | 'ready' | 'retrying' | 'terminal' | 'closed'
export type WorkspaceEventsRetryReason = 'network' | 'protocol' | 'body' | 'eof' | 'http'
export type WorkspaceEventsTerminal = { status: number }
export type WorkspaceEventsProtocolDiagnostic = { kind: 'malformed' | 'ignored' }

export type WorkspaceEventsClock = {
  now(): number
  wallNow(): number
  setTimeout(callback: () => void, delayMs: number): number
  clearTimeout(timer: number): void
}

export type WorkspaceEventsTelemetry = {
  onState(state: WorkspaceEventsClientState): void
  onRetrying(input: { reason: WorkspaceEventsRetryReason; delayMs: number }): void
  counter(name: 'attempt' | 'ready' | 'terminal' | 'malformed' | 'ignored' | 'resync' | 'closed'): void
  stableDuration(durationMs: number): void
  gaugeDelta(name: 'active', delta: 1 | -1): void
}

export type WorkspaceEventsClientOptions = {
  workspaceId: string
  fetch: typeof fetch
  clock: WorkspaceEventsClock
  random: () => number
  stableReadyMs?: number
  recoverAuthentication?: (signal: AbortSignal) => Promise<boolean>
  telemetry?: WorkspaceEventsTelemetry
}

export type WorkspaceEventsCallbacks = {
  onState: (state: WorkspaceEventsClientState) => void
  onRetrying: (input: { reason: WorkspaceEventsRetryReason; delayMs: number }) => void
  onReady?: () => void
  onInvalidate?: (frame: Extract<BrowserEventFrame, { type: 'invalidate' }>) => void
  onResync?: () => void
  onMalformed?: (diagnostic: WorkspaceEventsProtocolDiagnostic) => void
  onTerminal?: (terminal: WorkspaceEventsTerminal) => void
}

export type WorkspaceEventsConnection = { close(): void | Promise<void>; done: Promise<void> }
export type WorkspaceEventsClient = { connect(callbacks: WorkspaceEventsCallbacks): WorkspaceEventsConnection }

type Attempt = {
  readonly generation: number
  readonly controller: AbortController
  reader?: ReadableStreamDefaultReader<Uint8Array>
  response?: Response
  bodyCancelled: boolean
}

const defaultClock: WorkspaceEventsClock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
}

const swallow = (operation: () => void): void => {
  try { operation() } catch { /* User callbacks and telemetry cannot take down transport. */ }
}

const swallowPromise = (operation: () => Promise<unknown>): void => {
  try { void operation().catch(() => undefined) } catch { /* cancellation is best effort */ }
}

const boundedDelay = (delayMs: number): number => Math.max(MIN_RETRY_MS, Math.min(MAX_RETRY_MS, Math.ceil(delayMs)))

const serverRetryDelay = (delayMs: number): number =>
  Math.min(MAX_BROWSER_TIMER_MS, Math.max(MIN_RETRY_MS, Math.ceil(delayMs)))

const retryAfterDelay = (header: string | null, wallNow: number): number | undefined => {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return serverRetryDelay(seconds * 1_000)
  const date = Date.parse(header)
  if (!Number.isNaN(date) && date > wallNow) return serverRetryDelay(date - wallNow)
  return undefined
}

/** Byte-oriented parser so caps and UTF-8 validation remain correct across network chunks. */
class SseParser {
  private line: number[] = []
  private lineHasBytes = false
  private eventName = ''
  private data: string[] = []
  private eventBytes = 0
  private discard = false
  private invalidUtf8 = false
  private skipLineFeed = false
  private pendingCarriageReturnBoundary = false

  constructor(
    private readonly onEvent: (eventName: string, data: string) => void,
    private readonly onMalformed: () => void,
  ) {}

  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (this.pendingCarriageReturnBoundary) {
        if (byte === 0x0a) {
          this.eventBytes += 1
          if (this.eventBytes > BROWSER_FRAME_MAX_BYTES) this.discard = true
          this.dispatchEvent()
          this.pendingCarriageReturnBoundary = false
          this.skipLineFeed = false
          continue
        }
        this.dispatchEvent()
        this.pendingCarriageReturnBoundary = false
      }

      if (this.skipLineFeed && byte === 0x0a) {
        this.eventBytes += 1
        if (this.eventBytes > BROWSER_FRAME_MAX_BYTES) this.discard = true
        this.skipLineFeed = false
        continue
      }
      this.skipLineFeed = false
      this.eventBytes += 1
      if (this.eventBytes > BROWSER_FRAME_MAX_BYTES) this.discard = true

      if (byte === 0x0a || byte === 0x0d) {
        const boundary = this.endLine(byte === 0x0d)
        if (byte === 0x0d) {
          this.skipLineFeed = true
          this.pendingCarriageReturnBoundary = boundary
        }
      } else if (!this.discard) {
        this.lineHasBytes = true
        this.line.push(byte)
      } else {
        this.lineHasBytes = true
      }
    }
  }

  finish(): void {
    if (this.pendingCarriageReturnBoundary) {
      this.dispatchEvent()
      this.pendingCarriageReturnBoundary = false
      this.skipLineFeed = false
    }
  }

  private endLine(deferCarriageReturnBoundary: boolean): boolean {
    if (!this.lineHasBytes) {
      if (deferCarriageReturnBoundary) return true
      this.dispatchEvent()
      return true
    }

    if (!this.discard) {
      let line: string
      try { line = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(this.line)) } catch {
        this.invalidUtf8 = true
        this.line = []
        this.lineHasBytes = false
        return false
      }
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? '' : (line.charCodeAt(colon + 1) === 0x20 ? line.slice(colon + 2) : line.slice(colon + 1))
      if (field === 'event') this.eventName = value
      if (field === 'data') this.data.push(value)
    }
    this.line = []
    this.lineHasBytes = false
    return false
  }

  private dispatchEvent(): void {
    if (this.discard || this.invalidUtf8) this.onMalformed()
    else if (this.eventName || this.data.length > 0) this.onEvent(this.eventName, this.data.join('\n'))
    this.resetEvent()
  }

  private resetEvent(): void {
    this.line = []
    this.lineHasBytes = false
    this.eventName = ''
    this.data = []
    this.eventBytes = 0
    this.discard = false
    this.invalidUtf8 = false
    this.skipLineFeed = false
  }
}

class BrowserWorkspaceEventsClient implements WorkspaceEventsClient {
  constructor(private readonly options: WorkspaceEventsClientOptions) {}

  connect(callbacks: WorkspaceEventsCallbacks): WorkspaceEventsConnection {
    return new BrowserWorkspaceEventsConnection(this.options, callbacks)
  }
}

class BrowserWorkspaceEventsConnection implements WorkspaceEventsConnection {
  private readonly doneResolver: () => void
  readonly done: Promise<void>
  private closed = false
  private finalized = false
  private authenticatedOnce = false
  private retryExponent = 0
  private generation = 0
  private activeAttempt?: Attempt
  private retryTimer?: number
  private readyAt?: number
  private readySeen = false

  constructor(
    private readonly options: WorkspaceEventsClientOptions,
    private readonly callbacks: WorkspaceEventsCallbacks,
  ) {
    let resolve!: () => void
    this.done = new Promise<void>((doneResolve) => { resolve = doneResolve })
    this.doneResolver = resolve
    this.emitGauge(1)
    this.emitState('opened')
    void this.startAttempt()
  }

  close(): void {
    this.finish()
  }

  private isCurrent(attempt: Attempt): boolean {
    return !this.closed && this.activeAttempt === attempt && this.generation === attempt.generation
  }

  private async startAttempt(continuingAuthenticationChain = false): Promise<void> {
    if (this.closed) return
    if (!continuingAuthenticationChain) this.authenticatedOnce = false
    const attempt: Attempt = {
      generation: ++this.generation,
      controller: new AbortController(),
      bodyCancelled: false,
    }
    this.activeAttempt = attempt
    this.readySeen = false
    this.readyAt = undefined
    this.emitCounter('attempt')
    try {
      const response = await this.options.fetch(EVENTS_ENDPOINT, {
        method: 'GET', cache: 'no-store', credentials: 'include', redirect: 'manual',
        headers: new Headers({ Accept: 'text/event-stream', 'X-Workspace-Id': this.options.workspaceId }),
        signal: attempt.controller.signal,
      })
      attempt.response = response
      if (!this.isCurrent(attempt)) { this.cancelAttemptBody(attempt); return }
      await this.handleResponse(attempt, response)
    } catch {
      if (this.isCurrent(attempt)) this.scheduleRetry('network')
    }
  }

  private async handleResponse(attempt: Attempt, response: Response): Promise<void> {
    if (response.status === 400 || response.status === 403 || response.status === 404) {
      this.cancelAttemptBody(attempt)
      this.terminal({ status: response.status })
      return
    }
    if (response.status === 401) {
      this.cancelAttemptBody(attempt)
      if (this.authenticatedOnce || !this.options.recoverAuthentication) { this.terminal({ status: 401 }); return }
      this.authenticatedOnce = true
      try {
        const recovered = await this.options.recoverAuthentication(attempt.controller.signal)
        if (!this.isCurrent(attempt)) return
        if (!recovered) { this.terminal({ status: 401 }); return }
        void this.startAttempt(true)
      } catch {
        if (this.isCurrent(attempt)) this.terminal({ status: 401 })
      }
      return
    }
    if (response.status !== 200) {
      const retryAfterMs = response.status === 429 || response.status === 503
        ? retryAfterDelay(response.headers.get('retry-after'), this.options.clock.wallNow())
        : undefined
      this.cancelAttemptBody(attempt)
      if (this.isCurrent(attempt)) this.scheduleRetry('http', retryAfterMs)
      return
    }
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'text/event-stream' || !response.body) {
      this.cancelAttemptBody(attempt)
      if (this.isCurrent(attempt)) this.scheduleRetry('protocol')
      return
    }

    const parser = new SseParser(
      (eventName, data) => this.handleFrame(attempt, eventName, data),
      () => this.diagnostic('malformed'),
    )
    try {
      const reader = response.body.getReader()
      attempt.reader = reader
      while (this.isCurrent(attempt)) {
        const result = await reader.read()
        if (result.done) break
        parser.push(result.value)
      }
      parser.finish()
      if (this.isCurrent(attempt)) this.scheduleRetry('eof')
    } catch {
      this.cancelAttemptBody(attempt)
      if (this.isCurrent(attempt)) this.scheduleRetry('body')
    }
  }

  private handleFrame(attempt: Attempt, eventName: string, data: string): void {
    if (!this.isCurrent(attempt)) return
    if (eventName !== 'ready' && eventName !== 'invalidate' && eventName !== 'resync') {
      this.diagnostic('ignored')
      return
    }
    let parsed: unknown
    try { parsed = JSON.parse(data) } catch { this.diagnostic('malformed'); return }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.prototype.hasOwnProperty.call(parsed, 'type')) {
      this.diagnostic('malformed')
      return
    }
    // The event name is authoritative; the wire JSON is deliberately not allowed to supply `type`.
    const normalized = decodeBrowserEventFrame(JSON.stringify({ ...(parsed as Record<string, unknown>), type: eventName }))
    if (!normalized) { this.diagnostic('malformed'); return }
    if (normalized.type === 'ready') {
      if (this.readySeen) { this.diagnostic('ignored'); return }
      this.readySeen = true
      this.readyAt = this.options.clock.now()
      this.emitState('ready')
      this.emitCounter('ready')
      this.safeCallback(this.callbacks.onReady)
      return
    }
    if (!this.readySeen) { this.diagnostic('ignored'); return }
    if (normalized.type === 'invalidate') this.safeCallback(this.callbacks.onInvalidate, normalized)
    if (normalized.type === 'resync') {
      this.emitCounter('resync')
      this.safeCallback(this.callbacks.onResync)
    }
  }

  private scheduleRetry(reason: WorkspaceEventsRetryReason, serverDelay?: number): void {
    if (this.closed || this.retryTimer !== undefined) return
    if (this.readyAt !== undefined) {
      const stableDuration = Math.max(0, this.options.clock.now() - this.readyAt)
      if (stableDuration >= (this.options.stableReadyMs ?? DEFAULT_STABLE_READY_MS)) {
        this.retryExponent = 0
        swallow(() => this.options.telemetry?.stableDuration(stableDuration))
      }
    }
    const cap = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * (2 ** Math.min(this.retryExponent, 20)))
    const random = Math.max(0, Math.min(1, this.options.random()))
    const localDelay = boundedDelay(cap * random)
    const delayMs = serverDelay === undefined ? localDelay : Math.max(localDelay, serverDelay)
    this.retryExponent += 1
    this.emitState('retrying')
    if (this.closed) return
    const retry = { reason, delayMs }
    this.safeCallback(this.callbacks.onRetrying, retry)
    if (this.closed) return
    swallow(() => this.options.telemetry?.onRetrying(retry))
    if (this.closed) return
    this.retryTimer = this.options.clock.setTimeout(() => {
      this.retryTimer = undefined
      void this.startAttempt()
    }, delayMs)
  }

  private terminal(terminal: WorkspaceEventsTerminal): void {
    if (this.closed) return
    this.emitState('terminal')
    this.emitCounter('terminal')
    this.safeCallback(this.callbacks.onTerminal, terminal)
    this.finish()
  }

  private finish(): void {
    if (this.finalized) return
    this.closed = true
    this.finalized = true
    this.generation += 1
    if (this.retryTimer !== undefined) this.options.clock.clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const attempt = this.activeAttempt
    if (attempt) {
      attempt.controller.abort()
      this.cancelAttemptBody(attempt)
    }
    this.emitState('closed')
    this.emitCounter('closed')
    this.emitGauge(-1)
    this.doneResolver()
  }

  private cancelAttemptBody(attempt: Attempt): void {
    if (attempt.bodyCancelled) return
    if (attempt.reader) {
      attempt.bodyCancelled = true
      swallowPromise(() => attempt.reader!.cancel())
    } else if (attempt.response?.body) {
      attempt.bodyCancelled = true
      swallowPromise(() => attempt.response!.body!.cancel())
    }
  }

  private diagnostic(kind: WorkspaceEventsProtocolDiagnostic['kind']): void {
    this.emitCounter(kind)
    this.safeCallback(this.callbacks.onMalformed, { kind })
  }

  private emitState(state: WorkspaceEventsClientState): void {
    this.safeCallback(this.callbacks.onState, state)
    swallow(() => this.options.telemetry?.onState(state))
  }

  private emitCounter(name: Parameters<WorkspaceEventsTelemetry['counter']>[0]): void {
    swallow(() => this.options.telemetry?.counter(name))
  }

  private emitGauge(delta: 1 | -1): void {
    swallow(() => this.options.telemetry?.gaugeDelta('active', delta))
  }

  private safeCallback<T extends unknown[]>(callback: ((...args: T) => void) | undefined, ...args: T): void {
    if (callback) swallow(() => callback(...args))
  }
}

export const createWorkspaceEventsClient = (options: WorkspaceEventsClientOptions): WorkspaceEventsClient =>
  new BrowserWorkspaceEventsClient({ ...options, clock: options.clock ?? defaultClock })
