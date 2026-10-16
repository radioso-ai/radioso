/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VoiceRuntimeCallbacks } from '@/lib/voice-runtime'

const vendor = vi.hoisted(() => ({
  callbacks: null as VoiceRuntimeCallbacks | null,
  end: vi.fn(async () => undefined),
}))

vi.mock('@/lib/api-public-voice', () => ({
  startPublicVoiceSession: vi.fn(async () => ({
    kind: 'started',
    session: { vendor: 'elevenlabs', signedUrl: 'wss://vendor.test/s', sessionKey: 'session-key-1', locale: 'en' },
  })),
}))

vi.mock('@/lib/voice-runtime', () => ({
  prepareVoiceRuntimes: vi.fn(),
  loadVoiceRuntime: vi.fn(async () => ({
    open: async (_input: unknown, callbacks: VoiceRuntimeCallbacks) => {
      vendor.callbacks = callbacks
      return { end: vendor.end }
    },
  })),
}))

import { useVoiceSession } from '@/lib/use-voice-session'

type Session = ReturnType<typeof useVoiceSession>

const readNoMessage = () => 'greeting'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('useVoiceSession', () => {
  let container: HTMLDivElement
  let root: Root
  let latest: Session

  function Harness() {
    latest = useVoiceSession({ token: 'launch-token', currentMessageId: readNoMessage, offered: true })
    return null
  }

  const settle = () => act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  })

  beforeEach(async () => {
    vendor.callbacks = null
    vendor.end.mockClear()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    })
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it('adds nothing a vendor delivers after it hung up', async () => {
    await act(async () => latest.talk())
    await settle()
    await act(async () => {
      vendor.callbacks!.onConnected()
      vendor.callbacks!.onLine({ speaker: 'caller', text: 'Are you open on Sunday?' })
    })

    const callbacks = vendor.callbacks!
    await act(async () => {
      callbacks.onDisconnected()
      callbacks.onLine({ speaker: 'agent', text: 'Yes, from ten.' })
    })

    expect(latest.state).toEqual({ status: 'ended' })
    expect(latest.lines.map((line) => line.text)).toEqual(['Are you open on Sunday?'])
  })

  it('places each line after the chat message current when it arrived', async () => {
    await act(async () => latest.talk())
    await settle()
    await act(async () => vendor.callbacks!.onLine({ speaker: 'caller', text: 'Hello' }))

    expect(latest.lines).toEqual([{ id: 'voice-line-1', speaker: 'caller', text: 'Hello', afterMessageId: 'greeting' }])
  })

  it('takes a call stopped while connecting back to idle', async () => {
    await act(async () => latest.talk())
    await act(async () => latest.stop())
    await settle()

    expect(latest.state).toEqual({ status: 'idle' })
    expect(latest.isActive).toBe(false)
  })
})
