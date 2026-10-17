/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VoiceRuntimeCallbacks } from '@/lib/voice-runtime'

const vendor = vi.hoisted(() => ({
  callbacks: null as VoiceRuntimeCallbacks | null,
  end: vi.fn(async () => undefined),
  opens: 0,
  /** When set, `open` waits on it, as the vendor's client does while the microphone prompt is open. */
  hold: null as Promise<void> | null,
}))

vi.mock('@/lib/api-public-voice', () => ({
  startPublicVoiceSession: vi.fn(async () => ({
    kind: 'started',
    session: { vendor: 'elevenlabs', signedUrl: 'wss://vendor.test/s', sessionKey: 'session-key-1', locale: 'en', recordingNotice: 'This call is recorded.' },
  })),
  reportVoiceVendorConversation: vi.fn(async () => undefined),
}))

vi.mock('@/lib/voice-runtime', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/voice-runtime')>()),
  prepareVoiceRuntimes: vi.fn(),
  loadVoiceRuntimes: vi.fn(async () => ({
    elevenlabs: {
      open: async (_input: unknown, callbacks: VoiceRuntimeCallbacks) => {
        vendor.opens += 1
        if (vendor.hold) await vendor.hold
        vendor.callbacks = callbacks
        return { end: vendor.end, vendorConversationId: 'conv_1' }
      },
    },
  })),
}))

import { useVoiceSession } from '@/lib/use-voice-session'

type Session = ReturnType<typeof useVoiceSession>

const readMessageIds = () => ['greeting']

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('useVoiceSession', () => {
  let container: HTMLDivElement
  let root: Root
  let latest: Session

  function Harness() {
    latest = useVoiceSession({ token: 'launch-token', precedingMessageIds: readMessageIds, offered: true })
    return null
  }

  const settle = () => act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  })

  beforeEach(async () => {
    vendor.callbacks = null
    vendor.end.mockClear()
    vendor.opens = 0
    vendor.hold = null
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it("shows the agent's recording notice for the call, reports the vendor's id for it, and forgets the notice when the conversation is cleared", async () => {
    const { reportVoiceVendorConversation } = await import('@/lib/api-public-voice')
    await act(async () => latest.talk())
    await settle()

    expect(latest.recordingNotice).toBe('This call is recorded.')
    expect(reportVoiceVendorConversation).toHaveBeenCalledWith('launch-token', { sessionKey: 'session-key-1', vendorConversationId: 'conv_1' })

    await act(async () => latest.reset())
    expect(latest.recordingNotice).toBeNull()
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

    expect(latest.lines).toEqual([{ id: 'voice-line-1', speaker: 'caller', text: 'Hello', afterMessageIds: ['greeting'] }])
  })

  it('forgets the call and its lines when the conversation is cleared', async () => {
    await act(async () => latest.talk())
    await settle()
    await act(async () => {
      vendor.callbacks!.onConnected()
      vendor.callbacks!.onLine({ speaker: 'caller', text: 'Hello' })
    })

    await act(async () => latest.reset())

    expect(latest.state).toEqual({ status: 'idle' })
    expect(latest.lines).toEqual([])
    expect(vendor.end).toHaveBeenCalledTimes(1)
  })

  it('takes a call stopped while connecting back to idle', async () => {
    await act(async () => latest.talk())
    await act(async () => latest.stop())
    await settle()

    expect(latest.state).toEqual({ status: 'idle' })
    expect(latest.isActive).toBe(false)
  })

  it('starts a call pressed while the last one still connects only after that one let go', async () => {
    let release!: () => void
    vendor.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    await act(async () => latest.talk())
    await settle()
    expect(vendor.opens).toBe(1)

    await act(async () => latest.stop())
    await act(async () => latest.talk())
    await settle()
    expect(latest.state).toEqual({ status: 'connecting' })
    expect(vendor.opens).toBe(1)

    vendor.hold = null
    await act(async () => release())
    await settle()

    expect(vendor.end).toHaveBeenCalledTimes(1)
    expect(vendor.opens).toBe(2)
    await act(async () => vendor.callbacks!.onConnected())
    expect(latest.state).toEqual({ status: 'live', mode: 'listening' })
  })
})
