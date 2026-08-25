/* eslint-disable @next/next/no-assign-module-variable -- test imports isolate client module state. */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BROWSER_FRAME_MAX_BYTES,
  protocolVersion,
  type BrowserEventFrame,
} from '@radioso/workspace-invalidation-contract'

const ENDPOINT = '/backend/api/v1/events'
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const RAW_SSE_EVENT_CAP_BYTES = BROWSER_FRAME_MAX_BYTES
const encoder = new TextEncoder()

type InvalidateFrame = Extract<BrowserEventFrame, { type: 'invalidate' }>
type ClientTerminal = { status: number; retryAfterMs?: number }
type ClientRetryReason = 'network' | 'protocol' | 'body' | 'eof' | 'http'
type ClientState = 'opened' | 'ready' | 'retrying' | 'terminal' | 'closed'
type ClientProtocolDiagnostic = { kind: 'malformed' | 'ignored' }

type ClientClock = {
  now(): number
  wallNow(): number
  setTimeout(callback: () => void, delayMs: number): number
  clearTimeout(timer: number): void
}

type ClientTelemetry = {
  onState(state: ClientState): void
  onRetrying(input: { reason: ClientRetryReason; delayMs: number }): void
  counter(name: 'attempt' | 'ready' | 'terminal' | 'malformed' | 'ignored' | 'resync' | 'closed'): void
  stableDuration(durationMs: number): void
  gaugeDelta(name: 'active', delta: 1 | -1): void
}

type WorkspaceEventsClientOptions = {
  workspaceId: string
  fetch: typeof fetch
  clock: ClientClock
  random: () => number
  stableReadyMs?: number
  recoverAuthentication?: (signal: AbortSignal) => Promise<boolean>
  telemetry?: ClientTelemetry
}

type WorkspaceEventsCallbacks = {
  onState: (state: ClientState) => void
  onRetrying: (input: { reason: ClientRetryReason; delayMs: number }) => void
  onReady?: () => void
  onInvalidate?: (frame: InvalidateFrame) => void
  onResync?: () => void
  onMalformed?: (diagnostic: ClientProtocolDiagnostic) => void
  onTerminal?: (terminal: ClientTerminal) => void
}

type WorkspaceEventsConnection = {
  close(): void | Promise<void>
  done: Promise<void>
}

type WorkspaceEventsClient = {
  connect(callbacks: WorkspaceEventsCallbacks): WorkspaceEventsConnection
}

type WorkspaceEventsClientModule = {
  createWorkspaceEventsClient(input: WorkspaceEventsClientOptions): WorkspaceEventsClient
}

const loadClient = async () =>
  (await import('@/lib/workspace-events-client')) as unknown as WorkspaceEventsClientModule

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const flush = async () => {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
  }
}

class TestClock implements ClientClock {
  private nextTimer = 1
  private readonly timers = new Map<number, { at: number; callback: () => void }>()
  readonly scheduledDelays: number[] = []
  maxOutstanding = 0
  private current = 0
  private wallCurrent = Date.parse('2026-08-25T00:00:00.000Z')

  now(): number {
    return this.current
  }

  wallNow(): number {
    return this.wallCurrent
  }

  setWallNow(value: number): void {
    this.wallCurrent = value
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextTimer++
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), callback })
    this.scheduledDelays.push(Math.max(0, delayMs))
    this.maxOutstanding = Math.max(this.maxOutstanding, this.timers.size)
    return id
  }

  clearTimeout(timer: number): void {
    this.timers.delete(timer)
  }

  pendingCount(): number {
    return this.timers.size
  }

  async advance(deltaMs: number): Promise<void> {
    const target = this.current + deltaMs
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, left], [, right]) => left.at - right.at)[0]
      if (!due) break
      const [id, timer] = due
      this.timers.delete(id)
      this.current = timer.at
      timer.callback()
      await flush()
    }
    this.current = target
  }
}

const frame = (event: string, data: string, ending = '\n') =>
  `event: ${event}${ending}data: ${data}${ending}${ending}`

const readyFrame = (ending = '\n') => frame('ready', JSON.stringify({ protocolVersion }), ending)

const invalidateFrame = (
  kinds: readonly string[] = ['document.status_changed'],
  ending = '\n',
) => frame('invalidate', JSON.stringify({ protocolVersion, changeKinds: kinds }), ending)

const resyncFrame = (ending = '\n') => frame('resync', JSON.stringify({ protocolVersion }), ending)

const bytes = (value: string) => encoder.encode(value)

const streamFromChunks = (chunks: readonly Uint8Array[], onCancel?: (reason: unknown) => void) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
    cancel: onCancel,
  })

const responseFromChunks = (
  chunks: readonly Uint8Array[],
  status = 200,
  headers: Record<string, string> = { 'content-type': 'text/event-stream' },
  onCancel?: (reason: unknown) => void,
) => new Response(streamFromChunks(chunks, onCancel), { status, headers })

const responseFromText = (
  text: string,
  status = 200,
  headers: Record<string, string> = { 'content-type': 'text/event-stream' },
) => responseFromChunks([bytes(text)], status, headers)

const cancelableResponse = (
  status: number,
  onCancel: () => void,
  headers: Record<string, string> = { 'content-type': 'text/plain' },
) => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(bytes('discarded body'))
  },
  cancel: onCancel,
}), { status, headers })

const makeTelemetry = () => ({
  onState: vi.fn(),
  onRetrying: vi.fn(),
  counter: vi.fn(),
  stableDuration: vi.fn(),
  gaugeDelta: vi.fn(),
})

const makeCallbacks = () => ({
  onState: vi.fn(),
  onRetrying: vi.fn(),
  onReady: vi.fn(),
  onInvalidate: vi.fn(),
  onResync: vi.fn(),
  onMalformed: vi.fn(),
  onTerminal: vi.fn(),
})

const makeOptions = (
  fetchMock: typeof fetch,
  clock: TestClock,
  overrides: Partial<WorkspaceEventsClientOptions> = {},
): WorkspaceEventsClientOptions => ({
  workspaceId: WORKSPACE_ID,
  fetch: fetchMock,
  clock,
  random: () => 0.5,
  ...overrides,
})

const closeConnection = async (connection: WorkspaceEventsConnection) => {
  await Promise.resolve(connection.close())
  await flush()
  await connection.done
}

const expectFetchAttempt = (url: unknown, init: RequestInit | undefined) => {
  expect(url).toBe(ENDPOINT)
  expect(init?.method).toBe('GET')
  expect(init?.cache).toBe('no-store')
  expect(init?.credentials).toBe('include')
  expect(init?.redirect).toBe('manual')
  expect(init?.body).toBeUndefined()
  expect(init?.signal).toBeInstanceOf(AbortSignal)
  expect(init?.headers).toBeInstanceOf(Headers)
  const headers = new Headers(init?.headers)
  expect([...headers.keys()].sort()).toEqual(['accept', 'x-workspace-id'])
  expect(headers.get('accept')).toBe('text/event-stream')
  expect(headers.get('x-workspace-id')).toBe(WORKSPACE_ID)
  expect(headers.get('authorization')).toBeNull()
}

const expectActiveLifecycle = (telemetry: ReturnType<typeof makeTelemetry>) => {
  expect(telemetry.gaugeDelta.mock.calls).toEqual([
    ['active', 1],
    ['active', -1],
  ])
}

const nextMacrotask = () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))

const installUnhandledRejectionSpy = () => {
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  return {
    unhandled,
    remove: () => process.off('unhandledRejection', unhandled),
  }
}

const padRawFrame = (targetBytes: number, tail: string, ending = '\n') => {
  // The cap is on the complete UTF-8 bytes of one raw SSE event, including comments and delimiters.
  const tailBytes = bytes(tail).byteLength
  const endingBytes = bytes(ending).byteLength
  const fillerLength = targetBytes - tailBytes - endingBytes - 1
  if (fillerLength < 0) throw new Error('Test frame tail exceeds target size')
  return `:${'x'.repeat(fillerLength)}${ending}${tail}`
}

describe('workspace events browser client', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('uses one exact endpoint, GET fetch options, only Accept/X-Workspace-Id headers, and a fresh signal per attempt', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const second = deferred<Response>()
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('retry'))
      .mockReturnValueOnce(second.promise)
    const callbacks = makeCallbacks()
    const client = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock))
    const connection = client.connect(callbacks)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const [firstUrl, firstInit] = fetchMock.mock.calls[0]
    expectFetchAttempt(firstUrl, firstInit)

    await vi.waitFor(() => expect(clock.pendingCount()).toBe(1))
    await clock.advance(clock.scheduledDelays[0] ?? 0)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [secondUrl, secondInit] = fetchMock.mock.calls[1] ?? []
    expectFetchAttempt(secondUrl, secondInit)
    expect(secondInit?.signal).toBeInstanceOf(AbortSignal)
    expect(secondInit?.signal).not.toBe(firstInit?.signal)
    await closeConnection(connection)
    expect(secondInit?.signal?.aborted).toBe(true)
    second.resolve(responseFromText(readyFrame()))
  })

  it('parses one-byte fragmentation, split UTF-8, and delivers only normalized invalidation frames', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const fetchMock = vi.fn<typeof fetch>()
    const payload = `: UTF-8 comment 🌍\n${readyFrame()}${invalidateFrame(['conversation.created'])}`
    const chunks = [...bytes(payload)].map((value) => new Uint8Array([value]))
    fetchMock.mockResolvedValue(responseFromChunks(chunks))
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock)).connect(callbacks)

    await vi.waitFor(() => expect(callbacks.onInvalidate).toHaveBeenCalledOnce())
    expect(callbacks.onReady).toHaveBeenCalledOnce()
    expect(callbacks.onInvalidate).toHaveBeenCalledWith({
      protocolVersion,
      type: 'invalidate',
      changeKinds: ['conversation.created'],
    })
    await closeConnection(connection)
  })

  it.each(['\n', '\r\n', '\r'] as const)(
    'supports %j line endings, comments, multiple data lines, and multiple frames',
    async (ending) => {
      const module = await loadClient()
      const clock = new TestClock()
      const payload =
        `: ignored${ending}`
        + `event: ready${ending}`
        + `data: {"protocolVersion":1}${ending}${ending}`
        + `event: invalidate${ending}`
        + `data: {"protocolVersion":1,${ending}`
        + `data: "changeKinds":["crawl.progress"]}${ending}${ending}`
        + `event: resync${ending}`
        + `data: {"protocolVersion":1}${ending}${ending}`
      const fragmented = [...bytes(payload)].map((value) => new Uint8Array([value]))
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromChunks(fragmented))
      const callbacks = makeCallbacks()
      const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock)).connect(callbacks)

      await vi.waitFor(() => expect(callbacks.onResync).toHaveBeenCalledOnce())
      expect(callbacks.onReady).toHaveBeenCalledOnce()
      expect(callbacks.onInvalidate).toHaveBeenCalledWith({
        protocolVersion,
        type: 'invalidate',
        changeKinds: ['crawl.progress'],
      })
      expect(callbacks.onResync).toHaveBeenCalledOnce()
      await closeConnection(connection)
    },
  )

  it('dispatches a CR-only frame whose blank delimiter is exactly at EOF before reconnecting', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(responseFromText(`${readyFrame('\r')}${invalidateFrame(['crawl.progress'], '\r')}`))
      .mockReturnValueOnce(new Promise<Response>(() => {}))
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock, { random: () => 1 })).connect(callbacks)

    await vi.waitFor(() => expect(callbacks.onInvalidate).toHaveBeenCalledOnce())
    expect(callbacks.onReady).toHaveBeenCalledOnce()
    expect(clock.pendingCount()).toBe(1)
    expect(fetchMock).toHaveBeenCalledOnce()
    await clock.advance(clock.scheduledDelays[0] ?? 0)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(callbacks.onInvalidate.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[1] ?? Infinity)
    await closeConnection(connection)
  })

  it.each(['\n', '\r\n', '\r'] as const)(
    'accepts exactly the 4 KiB raw event boundary with %j and discards an oversized event before recovering',
    async (ending) => {
    const module = await loadClient()
    const clock = new TestClock()
    const exactKinds = ['conversation.created'] as const
    const oversizedKinds = ['conversation.turn_committed'] as const
    const recoveredKinds = ['document.status_changed'] as const
    const exactTail = invalidateFrame(exactKinds, ending)
    const exact = padRawFrame(RAW_SSE_EVENT_CAP_BYTES, exactTail, ending)
    const oversized = padRawFrame(
      RAW_SSE_EVENT_CAP_BYTES + 1,
      invalidateFrame(oversizedKinds, ending),
      ending,
    )
    expect(bytes(exact).byteLength).toBe(RAW_SSE_EVENT_CAP_BYTES)
    expect(bytes(oversized).byteLength).toBe(RAW_SSE_EVENT_CAP_BYTES + 1)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseFromText(`${readyFrame(ending)}${exact}${oversized}${invalidateFrame(recoveredKinds, ending)}`),
    )
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock)).connect(callbacks)

    await vi.waitFor(() => expect(callbacks.onInvalidate).toHaveBeenCalledTimes(2))
    expect(callbacks.onReady).toHaveBeenCalledOnce()
    expect(callbacks.onInvalidate).toHaveBeenCalledTimes(2)
    expect(callbacks.onInvalidate.mock.calls.map(([frame]) => frame.changeKinds)).toEqual([
      [...exactKinds],
      [...recoveredKinds],
    ])
    await closeConnection(connection)
    },
  )

  it.each(['\n', '\r\n', '\r'] as const)(
    'stays in discard mode across an oversized physical line and sacrificial suffix for %j',
    async (ending) => {
      const module = await loadClient()
      const clock = new TestClock()
      const discardedKinds = ['conversation.turn_committed'] as const
      const recoveredKinds = ['document.status_changed'] as const
      const oversizedLine = `${'x'.repeat(RAW_SSE_EVENT_CAP_BYTES + 1)}${ending}`
      const sacrificialLine = `data: {"protocolVersion":${protocolVersion}}${ending}`
      const discardedSuffix =
        `event: invalidate${ending}`
        + `data: {"protocolVersion":${protocolVersion},"changeKinds":["${discardedKinds[0]}"]}${ending}`
        + ending
      const followingFrame = invalidateFrame(recoveredKinds, ending)
      const payload = `${readyFrame(ending)}${oversizedLine}${sacrificialLine}${discardedSuffix}${followingFrame}`
      const chunks = [...bytes(payload)].map((value) => new Uint8Array([value]))
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromChunks(chunks))
      const callbacks = makeCallbacks()
      const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock)).connect(callbacks)

      await vi.waitFor(() => expect(callbacks.onReady).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(callbacks.onInvalidate).toHaveBeenCalledOnce())
      expect(callbacks.onInvalidate).toHaveBeenCalledWith({
        protocolVersion,
        type: 'invalidate',
        changeKinds: [...recoveredKinds],
      })
      expect(callbacks.onInvalidate.mock.calls.flatMap(([frame]) => frame.changeKinds)).not.toContain(discardedKinds[0])
      await closeConnection(connection)
    },
  )

  it('normalizes the SSE event name through the shared decoder and rejects type spoofing, malformed, unknown, and oversized content safely', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const telemetry = makeTelemetry()
    const malformedUtf8 = new Uint8Array([
      ...bytes('event: invalidate\ndata: {"protocolVersion":1,"changeKinds":["bad.'),
      0xc3,
      0x28,
      ...bytes('kind"]}\n\n'),
    ])
    const body = [
      bytes(`event: ready\ndata: {"protocolVersion":1,"type":"resync"}\n\n`),
      bytes(`event: ready\ndata: {"protocolVersion":2}\n\n`),
      bytes(`event: ready\ndata: {"protocolVersion":1,"extra":"reject"}\n\n`),
      bytes('event: unknown\ndata: {"protocolVersion":1}\n\n'),
      bytes('event: ready\ndata: {"protocolVersion":\n\n'),
      bytes('event: ready\ndata: {"protocolVersion":1}\n\n'),
      bytes('event: invalidate\ndata: {"protocolVersion":1,"changeKinds":[]}\n\n'),
      bytes('event: invalidate\ndata: {"protocolVersion":1,"changeKinds":["future.kind","document.status_changed"]}\n\n'),
      bytes('data: {"protocolVersion":1}\n\n'),
      malformedUtf8,
      bytes(invalidateFrame(['conversation.created'])),
    ]
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromChunks(body))
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock, { telemetry })).connect(callbacks)

    await vi.waitFor(() => expect(callbacks.onInvalidate).toHaveBeenCalledTimes(2))
    expect(callbacks.onReady).toHaveBeenCalledOnce()
    expect(callbacks.onInvalidate).toHaveBeenCalledTimes(2)
    expect(callbacks.onInvalidate).toHaveBeenNthCalledWith(1, {
      protocolVersion,
      type: 'invalidate',
      changeKinds: ['document.status_changed'],
    })
    expect(callbacks.onInvalidate).toHaveBeenNthCalledWith(2, {
      protocolVersion,
      type: 'invalidate',
      changeKinds: ['conversation.created'],
    })
    expect(callbacks.onMalformed.mock.calls.length).toBeGreaterThan(0)
    expect(callbacks.onMalformed.mock.calls.every(([diagnostic]) =>
      diagnostic.kind === 'malformed' || diagnostic.kind === 'ignored',
    )).toBe(true)
    expect(callbacks.onMalformed.mock.calls.every(([diagnostic]) =>
      Object.keys(diagnostic).sort().join(',') === 'kind',
    )).toBe(true)
    expect(JSON.stringify(callbacks.onMalformed.mock.calls)).not.toContain('bad.kind')
    expect(telemetry.counter.mock.calls.some(([name]) => name === 'malformed')).toBe(true)
    expect(telemetry.counter.mock.calls.some(([name]) => name === 'ignored')).toBe(true)
    expect(callbacks.onResync).not.toHaveBeenCalled()
    await closeConnection(connection)
  })

  it('makes type spoofing and extra-field rejection independently observable without accepting unknown kinds', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromText(
      `${readyFrame()}`
      + frame('invalidate', JSON.stringify({ protocolVersion, type: 'resync', changeKinds: ['conversation.created'] }))
      + frame('invalidate', JSON.stringify({ protocolVersion, changeKinds: ['conversation.turn_committed'], extra: 'reject' }))
      + invalidateFrame(['conversation.created'])
      + resyncFrame(),
    ))
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock)).connect(callbacks)

    await flush()
    expect(callbacks.onReady).toHaveBeenCalledOnce()
    expect(callbacks.onInvalidate).toHaveBeenCalledOnce()
    expect(callbacks.onInvalidate).toHaveBeenCalledWith({
      protocolVersion,
      type: 'invalidate',
      changeKinds: ['conversation.created'],
    })
    expect(callbacks.onResync).toHaveBeenCalledOnce()
    expect(callbacks.onMalformed).toHaveBeenCalledTimes(2)
    expect(callbacks.onMalformed.mock.calls).toEqual([
      [{ kind: 'malformed' }],
      [{ kind: 'malformed' }],
    ])
    await closeConnection(connection)
  })

  it('contains a throwing resync telemetry counter without dropping resync, retry, or cleanup', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const second = deferred<Response>()
    const telemetry = makeTelemetry()
    telemetry.counter.mockImplementation((name) => {
      if (name === 'resync') throw new Error('telemetry sink failed')
    })
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(responseFromText(`${readyFrame()}${resyncFrame()}`))
      .mockReturnValueOnce(second.promise)
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock, { telemetry })).connect(callbacks)

    await vi.waitFor(() => expect(callbacks.onResync).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(clock.pendingCount()).toBe(1))
    await clock.advance(clock.scheduledDelays[0] ?? 0)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    let lateCancelCalls = 0
    await closeConnection(connection)
    expect(clock.pendingCount()).toBe(0)
    second.resolve(responseFromChunks(
      [bytes(readyFrame())],
      200,
      { 'content-type': 'text/event-stream' },
      () => { lateCancelCalls += 1 },
    ))
    await flush()
    expect(lateCancelCalls).toBe(1)
  })

  it.each(['onState', 'onRetrying'] as const)(
    'allows %s retry control callback to close before installing a timer',
    async (hook) => {
      const module = await loadClient()
      const clock = new TestClock()
      const first = deferred<Response>()
      const fetchMock = vi.fn<typeof fetch>().mockReturnValue(first.promise)
      const callbacks = makeCallbacks()
      const controlCallback = hook === 'onState' ? callbacks.onState : callbacks.onRetrying
      const closeFromControl = () => {
        expect(clock.pendingCount()).toBe(0)
        void connection.close()
      }
      if (hook === 'onState') {
        callbacks.onState.mockImplementation((state) => {
          if (state === 'retrying') closeFromControl()
        })
      } else {
        callbacks.onRetrying.mockImplementation(closeFromControl)
      }
      const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock)).connect(callbacks)
      first.reject(new Error('transport failed'))

      await vi.waitFor(() => expect(controlCallback).toHaveBeenCalled())
      await expect(connection.done).resolves.toBeUndefined()
      expect(clock.pendingCount()).toBe(0)
      await clock.advance(60_000)
      expect(fetchMock).toHaveBeenCalledOnce()
      await closeConnection(connection)
    },
  )

  it('requires ready first, suppresses duplicate ready frames, and announces ready again on a new connection', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(responseFromText(`${invalidateFrame()}${readyFrame()}${readyFrame()}`))
      .mockResolvedValueOnce(responseFromText(`${readyFrame()}${readyFrame()}`))
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock)).connect(callbacks)

    await flush()
    expect(callbacks.onReady).toHaveBeenCalledOnce()
    expect(callbacks.onInvalidate).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(clock.pendingCount()).toBe(1))
    await clock.advance(clock.scheduledDelays[0] ?? 0)
    await flush()
    expect(callbacks.onReady).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchMock.mock.calls) expectFetchAttempt(url, init)
    await closeConnection(connection)
  })

  it.each([400, 403, 404] as const)('treats HTTP %s as terminal poll-only without retry', async (status) => {
    const module = await loadClient()
    const clock = new TestClock()
    let cancelCalls = 0
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      cancelableResponse(status, () => { cancelCalls += 1 }),
    )
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock)).connect(callbacks)

    await vi.waitFor(() => expect(callbacks.onTerminal).toHaveBeenCalledOnce())
    expect(callbacks.onTerminal).toHaveBeenCalledWith({ status })
    expect(cancelCalls).toBe(1)
    expect(clock.pendingCount()).toBe(0)
    await connection.done
  })

  it('accepts normalized event-stream media parameters and rejects event-streaming with body cancel and retry', async () => {
    const module = await loadClient()
    const acceptedClock = new TestClock()
    const acceptedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      responseFromText(readyFrame(), 200, { 'content-type': 'text/event-stream; charset=utf-8' }),
    )
    const acceptedCallbacks = makeCallbacks()
    const acceptedConnection = module.createWorkspaceEventsClient(makeOptions(acceptedFetch, acceptedClock)).connect(acceptedCallbacks)
    await flush()
    expect(acceptedCallbacks.onReady).toHaveBeenCalledOnce()
    await closeConnection(acceptedConnection)

    const rejectedClock = new TestClock()
    let cancelCalls = 0
    const rejectedFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(cancelableResponse(
        200,
        () => { cancelCalls += 1 },
        { 'content-type': 'text/event-streaming' },
      ))
      .mockReturnValueOnce(new Promise<Response>(() => {}))
    const rejectedCallbacks = makeCallbacks()
    const rejectedConnection = module.createWorkspaceEventsClient(makeOptions(rejectedFetch, rejectedClock)).connect(rejectedCallbacks)
    await vi.waitFor(() => expect(rejectedClock.pendingCount()).toBe(1))
    expect(cancelCalls).toBe(1)
    expect(rejectedCallbacks.onReady).not.toHaveBeenCalled()
    await closeConnection(rejectedConnection)
  })

  it.each([301, 302, 500, 503] as const)('cancels every unexpected or 3xx response body exactly once before retrying HTTP %s', async (status) => {
    const module = await loadClient()
    const clock = new TestClock()
    let cancelCalls = 0
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(cancelableResponse(status, () => { cancelCalls += 1 }, { 'content-type': 'text/event-stream' }))
      .mockReturnValueOnce(new Promise<Response>(() => {}))
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock)).connect(callbacks)

    await vi.waitFor(() => expect(clock.pendingCount()).toBe(1))
    expect(cancelCalls).toBe(1)
    expect(callbacks.onTerminal).not.toHaveBeenCalled()
    await closeConnection(connection)
  })

  it('recovers one 401 exactly once, retries successfully, and never exposes resource-fetch callbacks', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    let firstCancelCalls = 0
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(cancelableResponse(401, () => { firstCancelCalls += 1 }))
      .mockResolvedValueOnce(responseFromText(readyFrame()))
    const recover = vi.fn(async (signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return true
    })
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(
      makeOptions(fetchMock, clock, { recoverAuthentication: recover }),
    ).connect(callbacks)

    await flush()
    expect(recover).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(callbacks.onReady).toHaveBeenCalledOnce()
    expect(callbacks.onTerminal).not.toHaveBeenCalled()
    expect(firstCancelCalls).toBe(1)
    for (const [url, init] of fetchMock.mock.calls) expectFetchAttempt(url, init)
    await closeConnection(connection)
  })

  it.each([
    ['returns false', async (): Promise<boolean> => false],
    ['throws', async (): Promise<boolean> => { throw new Error('refresh failed') }],
  ] as const)('treats a failed 401 recovery (%s) as terminal without a second fetch', async (_name, recover) => {
    const module = await loadClient()
    const clock = new TestClock()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }))
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(
      makeOptions(fetchMock, clock, { recoverAuthentication: vi.fn(recover) }),
    ).connect(callbacks)

    await vi.waitFor(() => expect(callbacks.onTerminal).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(callbacks.onTerminal).toHaveBeenCalledWith({ status: 401 })
    await connection.done
  })

  it('does not refresh a second 401 and closes cleanly when recovery is aborted', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const second401 = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }))
    const recover = vi.fn(async () => true)
    second401.mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(null, { status: 401 }))
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(
      makeOptions(second401, clock, { recoverAuthentication: recover }),
    ).connect(callbacks)

    await vi.waitFor(() => expect(callbacks.onTerminal).toHaveBeenCalledOnce())
    expect(recover).toHaveBeenCalledOnce()
    expect(second401).toHaveBeenCalledTimes(2)
    for (const [url, init] of second401.mock.calls) expectFetchAttempt(url, init)
    await connection.done

    const recoveryGate = deferred<boolean>()
    const abortFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }))
    let recoverySignal!: AbortSignal
    const abortRecover = vi.fn((signal: AbortSignal) => {
      recoverySignal = signal
      return recoveryGate.promise
    })
    const abortCallbacks = makeCallbacks()
    const abortConnection = module.createWorkspaceEventsClient(
      makeOptions(abortFetch, clock, { recoverAuthentication: abortRecover }),
    ).connect(abortCallbacks)
    await vi.waitFor(() => expect(abortRecover).toHaveBeenCalledOnce())
    await closeConnection(abortConnection)
    expect(recoverySignal.aborted).toBe(true)
    recoveryGate.resolve(true)
    await flush()
    expect(abortFetch).toHaveBeenCalledOnce()
    for (const [url, init] of abortFetch.mock.calls) expectFetchAttempt(url, init)
    expect(abortCallbacks.onReady).not.toHaveBeenCalled()
    expect(abortCallbacks.onTerminal).not.toHaveBeenCalled()
  })

  it('grants a fresh one-recovery budget after a successful ready stream reconnects after EOF', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(responseFromText(readyFrame()))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(responseFromText(readyFrame()))
    const recover = vi.fn(async (signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return true
    })
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(
      makeOptions(fetchMock, clock, { random: () => 1, recoverAuthentication: recover }),
    ).connect(callbacks)

    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(clock.pendingCount()).toBe(1))
    await clock.advance(clock.scheduledDelays[0] ?? 0)
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(callbacks.onReady).toHaveBeenCalledTimes(2)
    expect(callbacks.onTerminal).not.toHaveBeenCalled()
    for (const [url, init] of fetchMock.mock.calls) expectFetchAttempt(url, init)
    await closeConnection(connection)
  })

  it('honors Retry-After seconds, HTTP dates, one-second floor, and backoff fallback for 429/503', async () => {
    const cases = [
      { header: '2', expected: 2_000 },
      { header: '0', expected: 1_000 },
      { header: 'invalid', expected: 1_000 },
      { header: '-5', expected: 1_000 },
      { header: 'NaN', expected: 1_000 },
      { header: '120', expected: 120_000 },
      { header: '999999', expected: 999_999_000 },
      { header: '2147483648', expected: 2_147_483_647 },
    ] as const

    for (const testCase of cases) {
      const module = await loadClient()
      const clock = new TestClock()
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, { status: 503, headers: { 'Retry-After': testCase.header } }),
      )
      const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock, { random: () => 1 })).connect(makeCallbacks())
      await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(1))
      expect(clock.scheduledDelays[0]).toBe(testCase.expected)
      await closeConnection(connection)
    }

    const module = await loadClient()
    const clock = new TestClock()
    const now = Date.parse('2026-08-25T00:00:00.000Z')
    clock.setWallNow(now)
    const dateHeader = new Date(now + 5_000).toUTCString()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': dateHeader } }),
    )
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock, { random: () => 1 })).connect(makeCallbacks())
    await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(1))
    expect(clock.scheduledDelays[0]).toBe(5_000)
    await closeConnection(connection)

    const pastClock = new TestClock()
    pastClock.setWallNow(now)
    const pastFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': new Date(now - 5_000).toUTCString() } }),
    )
    const pastConnection = module.createWorkspaceEventsClient(makeOptions(pastFetch, pastClock, { random: () => 1 })).connect(makeCallbacks())
    await vi.waitFor(() => expect(pastClock.scheduledDelays).toHaveLength(1))
    expect(pastClock.scheduledDelays[0]).toBe(1_000)
    await closeConnection(pastConnection)
  })

  it('uses Retry-After: 1 as a minimum while repeated HTTP 503 responses continue exponential backoff', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 503, headers: { 'Retry-After': '1' } }),
    )
    const callbacks = makeCallbacks()
    const connection = module.createWorkspaceEventsClient(
      makeOptions(fetchMock, clock, { random: () => 1 }),
    ).connect(callbacks)

    await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(1))
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await clock.advance(clock.scheduledDelays[attempt] ?? 0)
      await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(attempt + 2))
    }

    expect(clock.scheduledDelays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
    expect(callbacks.onRetrying.mock.calls.map(([retry]) => retry.delayMs)).toEqual(clock.scheduledDelays)
    expect(callbacks.onRetrying.mock.calls.every(([retry]) => retry.reason === 'http')).toBe(true)
    await closeConnection(connection)
  })

  it('lets a larger server Retry-After override the current exponential backoff delay', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 503, headers: { 'Retry-After': '45' } }),
    )
    const connection = module.createWorkspaceEventsClient(
      makeOptions(fetchMock, clock, { random: () => 1 }),
    ).connect(makeCallbacks())

    await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(1))
    expect(clock.scheduledDelays).toEqual([45_000])
    await closeConnection(connection)
  })

  it('uses Retry-After: 2 from repeated 429 responses as a minimum while local backoff grows', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': '2' } }),
    )
    const connection = module.createWorkspaceEventsClient(
      makeOptions(fetchMock, clock, { random: () => 1 }),
    ).connect(makeCallbacks())

    await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(1))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await clock.advance(clock.scheduledDelays[attempt] ?? 0)
      await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(attempt + 2))
    }

    expect(clock.scheduledDelays).toEqual([2_000, 2_000, 4_000, 8_000])
    await closeConnection(connection)
  })

  it('ignores Retry-After on unexpected 500 responses and uses local backoff', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 500, headers: { 'Retry-After': '60' } }),
    )
    const connection = module.createWorkspaceEventsClient(
      makeOptions(fetchMock, clock, { random: () => 1 }),
    ).connect(makeCallbacks())

    await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(1))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await clock.advance(clock.scheduledDelays[attempt] ?? 0)
      await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(attempt + 2))
    }

    expect(clock.scheduledDelays).toEqual([1_000, 2_000, 4_000])
    await closeConnection(connection)
  })

  it('retries network failure, wrong content type, body read failure, and EOF before ready', async () => {
    const module = await loadClient()
    const scenarios: Array<{
      name: string
      first: (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) => void
    }> = [
      {
        name: 'network failure',
        first: (fetchMock) => fetchMock.mockRejectedValueOnce(new Error('network')).mockReturnValueOnce(new Promise<Response>(() => {})),
      },
      {
        name: 'wrong content type',
        first: (fetchMock) => fetchMock.mockResolvedValueOnce(new Response('not-sse', { status: 200, headers: { 'content-type': 'application/json' } })).mockReturnValueOnce(new Promise<Response>(() => {})),
      },
      {
        name: 'missing body',
        first: (fetchMock) => fetchMock.mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } })).mockReturnValueOnce(new Promise<Response>(() => {})),
      },
      {
        name: 'unexpected status',
        first: (fetchMock) => fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 })).mockReturnValueOnce(new Promise<Response>(() => {})),
      },
      {
        name: 'body read failure',
        first: (fetchMock) => {
          const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('body failed')) } })
          fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })).mockReturnValueOnce(new Promise<Response>(() => {}))
        },
      },
      {
        name: 'EOF before ready',
        first: (fetchMock) => fetchMock.mockResolvedValueOnce(responseFromText('')).mockReturnValueOnce(new Promise<Response>(() => {})),
      },
      {
        name: 'unterminated ready at EOF',
        first: (fetchMock) => fetchMock
          .mockResolvedValueOnce(responseFromText('event: ready\ndata: {"protocolVersion":1}\n'))
          .mockReturnValueOnce(new Promise<Response>(() => {})),
      },
    ]

    for (const scenario of scenarios) {
      const clock = new TestClock()
      const fetchMock = vi.fn<typeof fetch>()
      scenario.first(fetchMock)
      const callbacks = makeCallbacks()
      const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock)).connect(callbacks)
      await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(1))
      expect(fetchMock.mock.calls[0]?.[0]).toBe(ENDPOINT)
      expect(callbacks.onReady).not.toHaveBeenCalled()
      expect(callbacks.onInvalidate).not.toHaveBeenCalled()
      expect(callbacks.onResync).not.toHaveBeenCalled()
      await closeConnection(connection)
    }
  })

  it('contains rejected body cancellation while retrying an invalid stream response', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    let cancelCalls = 0
    const unhandled = installUnhandledRejectionSpy()
    const invalidBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes('wrong body'))
      },
      cancel() {
        cancelCalls += 1
        return Promise.reject(new Error('cancel failed'))
      },
    })
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(invalidBody, { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockReturnValueOnce(new Promise<Response>(() => {}))
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock)).connect(makeCallbacks())

    try {
      await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(1))
      expect(cancelCalls).toBe(1)
      await nextMacrotask()
      await flush()
      expect(unhandled.unhandled).not.toHaveBeenCalled()
    } finally {
      unhandled.remove()
      await closeConnection(connection)
    }
  })

  it('uses deterministic exponential full jitter from 1 second through a 30-second cap and never schedules two timers', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const telemetry = makeTelemetry()
    const randomValues = [1, 0.5, 0.5, 1, 1, 1, 1]
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('network'))
    const retryCallbacks = makeCallbacks()
    retryCallbacks.onRetrying.mockImplementation(({ delayMs }) => {
      expect(delayMs).toBeGreaterThanOrEqual(1_000)
      expect(clock.pendingCount()).toBe(0)
    })
    const connection = module.createWorkspaceEventsClient(makeOptions(fetchMock, clock, {
      random: () => randomValues.shift() ?? 1,
      telemetry,
    })).connect(retryCallbacks)

    await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(1))
    expect(clock.scheduledDelays[0]).toBe(1_000)
    expect(retryCallbacks.onRetrying).toHaveBeenNthCalledWith(1, { reason: 'network', delayMs: 1_000 })
    expect(retryCallbacks.onState).toHaveBeenCalledWith('retrying')
    expect(telemetry.onRetrying).toHaveBeenNthCalledWith(1, { reason: 'network', delayMs: 1_000 })
    expect(telemetry.onState).toHaveBeenCalledWith('retrying')
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await clock.advance(clock.scheduledDelays[attempt] ?? 0)
      await vi.waitFor(() => expect(clock.scheduledDelays).toHaveLength(attempt + 2))
    }
    expect(clock.scheduledDelays).toEqual([1_000, 1_000, 2_000, 8_000, 16_000, 30_000, 30_000])
    expect(clock.scheduledDelays.every((delay) => delay >= 1_000 && delay <= 30_000)).toBe(true)
    expect(telemetry.onRetrying.mock.calls.map(([retry]) => retry.delayMs)).toEqual(clock.scheduledDelays)
    expect(retryCallbacks.onRetrying.mock.calls.map(([retry]) => retry.delayMs)).toEqual(clock.scheduledDelays)
    expect(fetchMock).toHaveBeenCalledTimes(clock.scheduledDelays.length)
    expect(retryCallbacks.onRetrying.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[1] ?? Infinity)
    expect(telemetry.onRetrying.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[1] ?? Infinity)
    for (const [url, init] of fetchMock.mock.calls) expectFetchAttempt(url, init)
    expect(clock.maxOutstanding).toBeLessThanOrEqual(1)
    await closeConnection(connection)
    expect(clock.pendingCount()).toBe(0)
  })

  it('resets backoff only after a stable ready interval; a short ready keeps the incremented backoff', async () => {
    const module = await loadClient()
    const shortClock = new TestClock()
    let shortController!: ReadableStreamDefaultController<Uint8Array>
    const shortBody = new ReadableStream<Uint8Array>({
      start(controller) {
        shortController = controller
        controller.enqueue(bytes(readyFrame()))
      },
    })
    const shortFetch = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce(new Response(shortBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockReturnValueOnce(new Promise<Response>(() => {}))
    const shortConnection = module.createWorkspaceEventsClient(
      makeOptions(shortFetch, shortClock, { stableReadyMs: 5_000, random: () => 1 }),
    ).connect(makeCallbacks())
    await vi.waitFor(() => expect(shortClock.scheduledDelays).toHaveLength(1))
    await shortClock.advance(1_000)
    await vi.waitFor(() => expect(shortFetch).toHaveBeenCalledTimes(2))
    await flush()
    shortClock.setWallNow(shortClock.wallNow() - 86_400_000)
    shortController.error(new Error('short ready'))
    await vi.waitFor(() => expect(shortClock.scheduledDelays).toHaveLength(2))
    expect(shortClock.scheduledDelays[1]).toBe(2_000)
    await closeConnection(shortConnection)

    const stableClock = new TestClock()
    const stableTelemetry = makeTelemetry()
    let stableController!: ReadableStreamDefaultController<Uint8Array>
    const stableBody = new ReadableStream<Uint8Array>({
      start(controller) {
        stableController = controller
        controller.enqueue(bytes(readyFrame()))
      },
    })
    const stableFetch = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce(new Response(stableBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockReturnValueOnce(new Promise<Response>(() => {}))
    const stableConnection = module.createWorkspaceEventsClient(
      makeOptions(stableFetch, stableClock, { stableReadyMs: 5_000, random: () => 1, telemetry: stableTelemetry }),
    ).connect(makeCallbacks())
    await vi.waitFor(() => expect(stableClock.scheduledDelays).toHaveLength(1))
    await stableClock.advance(1_000)
    await vi.waitFor(() => expect(stableFetch).toHaveBeenCalledTimes(2))
    await flush()
    stableClock.setWallNow(stableClock.wallNow() + 86_400_000)
    await stableClock.advance(5_000)
    stableController.error(new Error('stable stream ended'))
    await vi.waitFor(() => expect(stableClock.scheduledDelays).toHaveLength(2))
    expect(stableClock.scheduledDelays[1]).toBe(1_000)
    expect(stableClock.maxOutstanding).toBeLessThanOrEqual(1)
    expect(stableTelemetry.stableDuration).toHaveBeenCalledWith(5_000)
    await closeConnection(stableConnection)
  })

  it('closes during fetch, read, retry, recovery, and stable streaming with fenced late callbacks and idempotent cleanup', async () => {
    const module = await loadClient()

    const fetchClock = new TestClock()
    const fetchGate = deferred<Response>()
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(fetchGate.promise)
    const fetchCallbacks = makeCallbacks()
    const fetchConnection = module.createWorkspaceEventsClient(makeOptions(fetchMock, fetchClock)).connect(fetchCallbacks)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const fetchSignal = fetchMock.mock.calls[0]?.[1]?.signal
    let lateBodyCancelCalls = 0
    await closeConnection(fetchConnection)
    await closeConnection(fetchConnection)
    fetchGate.resolve(responseFromChunks(
      [bytes(readyFrame())],
      200,
      { 'content-type': 'text/event-stream' },
      () => { lateBodyCancelCalls += 1 },
    ))
    await flush()
    expect(fetchSignal?.aborted).toBe(true)
    expect(fetchCallbacks.onReady).not.toHaveBeenCalled()
    expect(lateBodyCancelCalls).toBe(1)

    const readClock = new TestClock()
    let readController!: ReadableStreamDefaultController<Uint8Array>
    let readCancelCalls = 0
    const readBody = new ReadableStream<Uint8Array>({
      start(controller) {
        readController = controller
        controller.enqueue(bytes(readyFrame()))
      },
      cancel() {
        readCancelCalls += 1
      },
    })
    const readFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(readBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const readCallbacks = makeCallbacks()
    const readConnection = module.createWorkspaceEventsClient(makeOptions(readFetch, readClock)).connect(readCallbacks)
    await flush()
    await closeConnection(readConnection)
    readController.error(new Error('late read error'))
    await flush()
    expect(readCancelCalls).toBe(1)
    expect(readCallbacks.onReady).toHaveBeenCalledOnce()

    const retryClock = new TestClock()
    const retryFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('retry'))
    const retryCallbacks = makeCallbacks()
    const retryConnection = module.createWorkspaceEventsClient(makeOptions(retryFetch, retryClock)).connect(retryCallbacks)
    await vi.waitFor(() => expect(retryClock.pendingCount()).toBe(1))
    await closeConnection(retryConnection)
    await retryClock.advance(60_000)
    expect(retryFetch).toHaveBeenCalledOnce()

    const recoveryClock = new TestClock()
    const recoveryGate = deferred<boolean>()
    const recoveryFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }))
    const recovery = vi.fn(() => recoveryGate.promise)
    const recoveryCallbacks = makeCallbacks()
    const recoveryConnection = module.createWorkspaceEventsClient(
      makeOptions(recoveryFetch, recoveryClock, { recoverAuthentication: recovery }),
    ).connect(recoveryCallbacks)
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce())
    await closeConnection(recoveryConnection)
    recoveryGate.resolve(true)
    await flush()
    expect(recoveryFetch).toHaveBeenCalledOnce()
    expect(recoveryCallbacks.onReady).not.toHaveBeenCalled()

    void readController
  })

  it('does not install document visibility listeners, contains callback throws, and emits only redacted fixed-card telemetry', async () => {
    const module = await loadClient()
    const clock = new TestClock()
    const telemetry = makeTelemetry()
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    vi.stubGlobal('document', { addEventListener, removeEventListener })
    const unhandled = installUnhandledRejectionSpy()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseFromText(`${readyFrame()}${invalidateFrame(['quality.feedback_changed'])}${resyncFrame()}`),
    )
    const connection = module.createWorkspaceEventsClient(
      makeOptions(fetchMock, clock, { telemetry }),
    ).connect({
      onState: () => undefined,
      onRetrying: () => undefined,
      onReady: () => { throw new Error(`callback leaked ${WORKSPACE_ID}`) },
      onInvalidate: () => { throw new Error('invalidation callback failed') },
      onResync: () => { throw new Error('resync callback failed') },
      onTerminal: () => { throw new Error('terminal callback failed') },
    })

    try {
      await flush()
      await closeConnection(connection)
      expect(addEventListener).not.toHaveBeenCalled()
      expect(removeEventListener).not.toHaveBeenCalled()
      const telemetryCalls = [
        ...telemetry.counter.mock.calls,
        ...telemetry.gaugeDelta.mock.calls,
        ...telemetry.onState.mock.calls,
        ...telemetry.onRetrying.mock.calls,
      ]
      expect(JSON.stringify(telemetryCalls)).not.toContain(WORKSPACE_ID)
      expect(JSON.stringify(telemetryCalls)).not.toContain('quality.feedback_changed')
      expect(telemetry.counter.mock.calls.every(([name]) =>
        ['attempt', 'ready', 'terminal', 'malformed', 'ignored', 'resync', 'closed'].includes(String(name)),
      )).toBe(true)
      expect(telemetry.gaugeDelta.mock.calls.every(([name, delta]) =>
        name === 'active' && (delta === 1 || delta === -1),
      )).toBe(true)
      expect(telemetry.onState.mock.calls.every(([state]) =>
        ['opened', 'ready', 'retrying', 'terminal', 'closed'].includes(String(state)),
      )).toBe(true)
      expect(telemetry.onState).toHaveBeenCalledWith('opened')
      expect(telemetry.onState).toHaveBeenCalledWith('ready')
      expect(telemetry.onRetrying.mock.calls.every(([retry]) =>
        ['network', 'protocol', 'body', 'eof', 'http'].includes(String(retry.reason))
        && Number.isFinite(retry.delayMs)
        && retry.delayMs > 0
        && retry.delayMs <= 30_000,
      )).toBe(true)
      expect(telemetry.onRetrying.mock.calls.every(([retry]) =>
        Object.keys(retry).sort().join(',') === 'delayMs,reason',
      )).toBe(true)
      expect(telemetry.stableDuration.mock.calls.every(([duration]) =>
        Number.isFinite(duration) && duration >= 0,
      )).toBe(true)
      expectActiveLifecycle(telemetry)
      expect(telemetry.counter).toHaveBeenCalledWith('attempt')
      expect(telemetry.counter).toHaveBeenCalledWith('ready')
      expect(telemetry.counter.mock.calls.some(([name]) => name === 'resync')).toBe(true)
      expect(telemetry.counter).toHaveBeenCalledWith('closed')
      expect(telemetry.counter.mock.calls.filter(([name]) => name === 'closed')).toHaveLength(1)

      let terminalCancelCalls = 0
      const terminalTelemetry = makeTelemetry()
      const terminalCallbacks = makeCallbacks()
      terminalCallbacks.onTerminal.mockImplementation(() => { throw new Error('terminal callback failed') })
      const terminalFetch = vi.fn<typeof fetch>().mockResolvedValue(
        cancelableResponse(400, () => { terminalCancelCalls += 1 }),
      )
      const terminalConnection = module.createWorkspaceEventsClient(
        makeOptions(terminalFetch, clock, { telemetry: terminalTelemetry }),
      ).connect(terminalCallbacks)
      await expect(terminalConnection.done).resolves.toBeUndefined()
      expect(terminalCancelCalls).toBe(1)
      expect(terminalCallbacks.onTerminal).toHaveBeenCalledWith({ status: 400 })
      expect(terminalTelemetry.onState).toHaveBeenCalledWith('terminal')
      expect(terminalTelemetry.onState).toHaveBeenCalledWith('closed')
      expect(terminalTelemetry.counter).toHaveBeenCalledWith('terminal')
      expect(terminalTelemetry.counter.mock.calls.filter(([name]) => name === 'closed')).toHaveLength(1)
      expectActiveLifecycle(terminalTelemetry)
      await flush()
      expect(unhandled.unhandled).not.toHaveBeenCalled()
    } finally {
      unhandled.remove()
      await closeConnection(connection)
    }
  })
})
