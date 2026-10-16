import { afterEach, describe, expect, it, vi } from 'vitest'

import { runVoiceCall, VOICE_CALL_BEHAVIOR, type VoiceCallDependencies, type VoiceSessionStart } from '@/lib/voice-call'
import { VoiceMicrophoneUnavailableError, type VoiceRuntime, type VoiceRuntimeCallbacks } from '@/lib/voice-runtime'
import type { VoiceSessionEvent } from '@/lib/voice-session'

const started: VoiceSessionStart = {
  kind: 'started',
  session: { vendor: 'elevenlabs', signedUrl: 'wss://vendor.test/session?sig=1', sessionKey: 'session-key-1', locale: 'it' },
}

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const callWith = (overrides: Partial<VoiceCallDependencies> & { openSession?: VoiceRuntime['open'] } = {}) => {
  const events: VoiceSessionEvent[] = []
  const lines: unknown[] = []
  const end = vi.fn(async () => undefined)
  let callbacks: VoiceRuntimeCallbacks | null = null
  let signal: AbortSignal | null = null
  const open = vi.fn<VoiceRuntime['open']>(overrides.openSession ?? (async (_input, given, abort) => {
    callbacks = given
    signal = abort
    return { end }
  }))
  const dependencies: VoiceCallDependencies = {
    startSession: overrides.startSession ?? vi.fn(async () => started),
    loadRuntimes: overrides.loadRuntimes ?? vi.fn(async () => ({ elevenlabs: { open } })),
    ...(overrides.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: overrides.connectTimeoutMs }),
  }
  const call = runVoiceCall(dependencies, { onEvent: (event) => events.push(event), onLine: (line) => lines.push(line) })
  return { call, dependencies, events, lines, open, end, vendor: () => callbacks!, signal: () => signal! }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a voice call', () => {
  it("loads the vendor's client before the start, then opens the session with what the start returned", async () => {
    const order: string[] = []
    const { open, events, lines, vendor } = callWith({
      loadRuntimes: async () => {
        order.push('load')
        return { elevenlabs: { open: async (input, given, abort) => { order.push('open'); return open(input, given, abort) } } }
      },
      startSession: async () => {
        order.push('start')
        return started
      },
    })
    await flush()

    expect(order).toEqual(['load', 'start', 'open'])
    expect(open).toHaveBeenCalledWith(
      { signedUrl: 'wss://vendor.test/session?sig=1', sessionKey: 'session-key-1', locale: 'it' },
      expect.any(Object),
      expect.any(AbortSignal),
    )
    vendor().onConnected()
    vendor().onModeChange('speaking')
    vendor().onLine({ speaker: 'agent', text: 'Ciao!' })
    vendor().onDisconnected()
    expect(events).toEqual([
      { type: 'connected' },
      { type: 'mode_changed', mode: 'speaking' },
      { type: 'disconnected' },
    ])
    expect(lines).toEqual([{ speaker: 'agent', text: 'Ciao!' }])
  })

  it("spends no session start when the vendor's client cannot load", async () => {
    const startSession = vi.fn(async () => started)
    const { events } = callWith({ loadRuntimes: async () => { throw new Error('ChunkLoadError') }, startSession })
    await flush()

    expect(events).toEqual([{ type: 'start_refused' }])
    expect(startSession).not.toHaveBeenCalled()
  })

  it("reads the vendor client's refused or missing microphone as the microphone line", async () => {
    const { events } = callWith({ openSession: async () => { throw new VoiceMicrophoneUnavailableError() } })
    await flush()

    expect(events).toEqual([{ type: 'microphone_refused' }])
  })

  it('opens nothing when the start is refused', async () => {
    const { events, open } = callWith({ startSession: async () => ({ kind: 'refused' }) })
    await flush()

    expect(events).toEqual([{ type: 'start_refused' }])
    expect(open).not.toHaveBeenCalled()
  })

  it('reads a vendor that cannot open the session as a refused start', async () => {
    const { events } = callWith({ openSession: async () => { throw new Error('socket closed') } })
    await flush()

    expect(events).toEqual([{ type: 'start_refused' }])
  })

  it('fails a live call on a vendor error that leaves the socket open, ends the session and reports nothing after', async () => {
    const { events, end, lines, vendor } = callWith()
    await flush()
    vendor().onConnected()

    vendor().onFailed()
    vendor().onLine({ speaker: 'agent', text: 'late' })
    vendor().onDisconnected()

    expect(events).toEqual([{ type: 'connected' }, { type: 'call_failed' }])
    expect(end).toHaveBeenCalledTimes(1)
    expect(lines).toEqual([])
  })

  it('gives up on a handshake the vendor does not answer in time, abandoning it so the microphone is released', async () => {
    vi.useFakeTimers()
    const opening = deferred<{ end: () => Promise<void> }>()
    let given: VoiceRuntimeCallbacks | null = null
    let abort: AbortSignal | null = null
    const end = vi.fn(async () => undefined)
    const { events } = callWith({
      openSession: (_input, callbacks, signal) => {
        given = callbacks
        abort = signal
        return opening.promise
      },
    })
    await flush()
    given!.onConnecting()

    await vi.advanceTimersByTimeAsync(VOICE_CALL_BEHAVIOR.connectTimeoutMs - 1)
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(1)

    expect(events).toEqual([{ type: 'call_failed' }])
    expect(abort!.aborted).toBe(true)
    opening.resolve({ end })
    await flush()
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('waits as long as the visitor takes on the microphone prompt: the clock starts with the handshake', async () => {
    vi.useFakeTimers()
    const { events } = callWith({ openSession: () => new Promise(() => undefined) })
    await flush()

    await vi.advanceTimersByTimeAsync(VOICE_CALL_BEHAVIOR.connectTimeoutMs * 3)

    expect(events).toEqual([])
  })

  it('keeps a call whose vendor answers the handshake in time', async () => {
    vi.useFakeTimers()
    const { events, vendor } = callWith({ connectTimeoutMs: 1_000 })
    await flush()
    vendor().onConnecting()
    vendor().onConnected()

    await vi.advanceTimersByTimeAsync(5_000)

    expect(events).toEqual([{ type: 'connected' }])
  })

  it('ends the vendor session on stop and reports nothing after it', async () => {
    const { call, end, events, lines, vendor, signal } = callWith()
    await flush()

    call.stop()
    vendor().onLine({ speaker: 'caller', text: 'late' })
    vendor().onDisconnected()

    expect(end).toHaveBeenCalledTimes(1)
    expect(signal().aborted).toBe(true)
    expect(events).toEqual([])
    expect(lines).toEqual([])
  })

  it("ends the vendor's session when stopped while the vendor opens it", async () => {
    const opening = deferred<{ end: () => Promise<void> }>()
    const end = vi.fn(async () => undefined)
    const { call, events } = callWith({ openSession: () => opening.promise })
    await flush()

    call.stop()
    opening.resolve({ end })
    await flush()

    expect(end).toHaveBeenCalledTimes(1)
    expect(events).toEqual([])
  })

  it('opens no vendor session when stopped while Radioso starts one', async () => {
    const starting = deferred<VoiceSessionStart>()
    const { call, events, open } = callWith({ startSession: () => starting.promise })
    await flush()

    call.stop()
    starting.resolve(started)
    await flush()

    expect(open).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it("starts nothing when stopped while the vendor's client loads", async () => {
    const loading = deferred<Readonly<Record<'elevenlabs', VoiceRuntime>>>()
    const startSession = vi.fn(async () => started)
    const { call, events } = callWith({ loadRuntimes: () => loading.promise, startSession })

    call.stop()
    loading.resolve({ elevenlabs: { open: vi.fn() } })
    await flush()

    expect(startSession).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })
})
