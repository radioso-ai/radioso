import { describe, expect, it, vi } from 'vitest'

import { runVoiceCall, type VoiceCallDependencies, type VoiceSessionStart } from '@/lib/voice-call'
import type { VoiceRuntime, VoiceRuntimeCallbacks } from '@/lib/voice-runtime'
import type { VoiceSessionEvent } from '@/lib/voice-session'

const started: VoiceSessionStart = {
  kind: 'started',
  session: { vendor: 'elevenlabs', signedUrl: 'wss://vendor.test/session?sig=1', sessionKey: 'session-key-1', locale: 'it' },
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

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
  const open = vi.fn<VoiceRuntime['open']>(overrides.openSession ?? (async (_input, given) => {
    callbacks = given
    return { end }
  }))
  const dependencies: VoiceCallDependencies = {
    requestMicrophone: overrides.requestMicrophone ?? vi.fn(async () => true),
    startSession: overrides.startSession ?? vi.fn(async () => started),
    loadRuntime: overrides.loadRuntime ?? vi.fn(async () => ({ open })),
  }
  const call = runVoiceCall(dependencies, { onEvent: (event) => events.push(event), onLine: (line) => lines.push(line) })
  return { call, dependencies, events, lines, open, end, vendor: () => callbacks! }
}

describe('a voice call', () => {
  it('opens the vendor session with what the start returned and reports the vendor', async () => {
    const { open, events, lines, vendor } = callWith()
    await flush()

    expect(open).toHaveBeenCalledWith(
      { signedUrl: 'wss://vendor.test/session?sig=1', sessionKey: 'session-key-1', locale: 'it' },
      expect.any(Object),
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

  it('spends no session start when the microphone is refused', async () => {
    const startSession = vi.fn(async () => started)
    const { events } = callWith({ requestMicrophone: async () => false, startSession })
    await flush()

    expect(events).toEqual([{ type: 'microphone_refused' }])
    expect(startSession).not.toHaveBeenCalled()
  })

  it('loads no vendor client when the start is refused', async () => {
    const loadRuntime = vi.fn()
    const { events } = callWith({ startSession: async () => ({ kind: 'refused' }), loadRuntime })
    await flush()

    expect(events).toEqual([{ type: 'start_refused' }])
    expect(loadRuntime).not.toHaveBeenCalled()
  })

  it('reads a vendor that cannot open the session as a refused start', async () => {
    const { events } = callWith({ openSession: async () => { throw new Error('socket closed') } })
    await flush()

    expect(events).toEqual([{ type: 'start_refused' }])
  })

  it('ends the vendor session on stop and reports nothing after it', async () => {
    const { call, end, events, lines, vendor } = callWith()
    await flush()

    call.stop()
    vendor().onLine({ speaker: 'caller', text: 'late' })
    vendor().onDisconnected()

    expect(end).toHaveBeenCalledTimes(1)
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
    const loadRuntime = vi.fn()
    const { call, events } = callWith({ startSession: () => starting.promise, loadRuntime })
    await flush()

    call.stop()
    starting.resolve(started)
    await flush()

    expect(loadRuntime).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('starts nothing when stopped while the microphone prompt is open', async () => {
    const microphone = deferred<boolean>()
    const startSession = vi.fn(async () => started)
    const { call, events } = callWith({ requestMicrophone: () => microphone.promise, startSession })

    call.stop()
    microphone.resolve(true)
    await flush()

    expect(startSession).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })
})
