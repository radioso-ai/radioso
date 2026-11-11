/* @vitest-environment jsdom */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VoiceRuntimeCallbacks } from '@/lib/voice-runtime'

// Test Chat's Talk across several calls (#1536 review): a call belongs to the test its start
// resolved to, and only a call whose test is no longer the one on screen is ended.

const vendor = vi.hoisted(() => ({
  callbacks: null as VoiceRuntimeCallbacks | null,
  end: vi.fn(async () => undefined),
  opens: 0,
}))

const starts = vi.hoisted(() => ({ executionIds: [] as string[] }))

vi.mock('@/lib/api', () => ({
  agentsApi: {
    getAgent: vi.fn(async () => ({
      voice: { enabled: true, runtime: { vendor: 'elevenlabs', agentId: 'agent_42', region: 'eu' } },
      voiceCallReadiness: { ready: true, missing: null },
    })),
  },
}))

vi.mock('@/lib/api-test-chat-voice', () => ({
  startTestChatVoiceSession: vi.fn(async (_agentId: string, executionId: string) => {
    starts.executionIds.push(executionId)
    return { kind: 'started', session: { vendor: 'elevenlabs', signedUrl: 'wss://vendor.test/s', sessionKey: `key-${starts.executionIds.length}`, locale: 'en' } }
  }),
}))

vi.mock('@/lib/api-agent-revisions', () => ({
  agentRevisionsApi: { getTestExecution: vi.fn(async () => new Promise(() => undefined)) },
}))

vi.mock('@/lib/use-voice-session', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/use-voice-session')>()),
  // The page can always ask for a microphone here; the readiness read decides whether Talk shows.
  useCanAskForMicrophone: (wanted: boolean) => wanted,
}))

vi.mock('@/lib/voice-runtime', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/voice-runtime')>()),
  prepareVoiceRuntimes: vi.fn(),
  loadVoiceRuntimes: vi.fn(async () => ({
    elevenlabs: {
      open: async (_input: unknown, callbacks: VoiceRuntimeCallbacks) => {
        vendor.opens += 1
        vendor.callbacks = callbacks
        return { end: vendor.end }
      },
    },
  })),
}))

import { TestChatComposer } from '@/components/dashboard/test-chat-composer'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

/**
 * Test Chat as the composer meets it: the test on screen, which New chat clears and opening another
 * test replaces, and the start that prepares the test the next turn runs on (a fresh one when none is
 * open, as Test Chat's own start does).
 */
let showTest: (executionId: string | null) => void = () => undefined
let nextTest = 'test-1'

function Harness() {
  const [executionId, setExecutionId] = useState<string | null>('test-1')
  showTest = setExecutionId
  return (
    <TestChatComposer
      agentId="agent-1"
      message=""
      onMessageChange={() => undefined}
      onSubmit={() => undefined}
      canSend
      sendLabel="Send"
      isStarting={false}
      talk={{
        executionId,
        prepareExecution: async () => {
          if (executionId) return executionId
          setExecutionId(nextTest)
          return nextTest
        },
        onSpokenTurns: () => undefined,
      }}
    />
  )
}

describe('Test Chat Talk across calls', () => {
  let container: HTMLDivElement
  let root: Root

  const settle = () => act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((candidate) => candidate.title === label || candidate.textContent?.trim() === label) ?? null
  const press = async (label: string) => {
    const target = button(label)
    if (!target) throw new Error(`No ${label} button`)
    await act(async () => target.click())
    await settle()
  }
  /** One call from Talk to End call, connected in between. */
  const callAndEnd = async () => {
    await press('Talk')
    await act(async () => vendor.callbacks?.onConnected())
    await press('End call')
  }

  beforeEach(async () => {
    vendor.callbacks = null
    vendor.end.mockClear()
    vendor.opens = 0
    starts.executionIds = []
    nextTest = 'test-1'
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root.render(<Harness />))
    await settle()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it('starts a second call on the same test and keeps it open', async () => {
    await callAndEnd()
    expect(vendor.end).toHaveBeenCalledTimes(1)

    await press('Talk')

    expect(starts.executionIds).toEqual(['test-1', 'test-1'])
    expect(vendor.opens).toBe(2)
    expect(vendor.end).toHaveBeenCalledTimes(1)
    expect(button('End call')).not.toBeNull()
  })

  it('starts a call after New chat on the fresh test its start prepares, and keeps it open', async () => {
    await callAndEnd()
    await act(async () => showTest(null))
    nextTest = 'test-2'

    await press('Talk')

    expect(starts.executionIds).toEqual(['test-1', 'test-2'])
    expect(vendor.opens).toBe(2)
    expect(vendor.end).toHaveBeenCalledTimes(1)
    expect(button('End call')).not.toBeNull()
  })

  it('starts a call on another test opened after the last call ended, and keeps it open', async () => {
    await callAndEnd()
    await act(async () => showTest('test-3'))

    await press('Talk')

    expect(starts.executionIds).toEqual(['test-1', 'test-3'])
    expect(vendor.opens).toBe(2)
    expect(vendor.end).toHaveBeenCalledTimes(1)
    expect(button('End call')).not.toBeNull()
  })

  it('ends a running call once another test is opened in its place', async () => {
    await press('Talk')
    await act(async () => vendor.callbacks?.onConnected())

    await act(async () => showTest('test-4'))
    await settle()

    expect(vendor.end).toHaveBeenCalledTimes(1)
    expect(button('End call')).toBeNull()
  })
})
