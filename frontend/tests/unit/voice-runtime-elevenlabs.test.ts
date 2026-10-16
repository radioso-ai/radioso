import { beforeEach, describe, expect, it, vi } from 'vitest'

const startSession = vi.fn()
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: (options: unknown) => startSession(options) } }))

import { GET } from '@/app/voice-worklets/[name]/route'
import { elevenLabsVoiceRuntime } from '@/lib/voice-runtime-elevenlabs'

type CapturedOptions = {
  signedUrl: string
  connectionType: string
  customLlmExtraBody: unknown
  workletPaths: Record<string, string>
  libsampleratePath: string
  onConnect: (props: { conversationId: string }) => void
  onModeChange: (props: { mode: 'speaking' | 'listening' }) => void
  onMessage: (props: { message: string; role: 'user' | 'agent'; event_id: number; source: string; response_id?: string }) => void
  onDisconnect: (details: { reason: 'user' }) => void
}

const callbacks = () => ({ onConnected: vi.fn(), onModeChange: vi.fn(), onLine: vi.fn(), onDisconnected: vi.fn() })

describe('ElevenLabs voice runtime', () => {
  const endSession = vi.fn(async () => undefined)
  beforeEach(() => {
    startSession.mockReset()
    startSession.mockResolvedValue({ endSession })
  })

  it("opens the signed URL over a websocket with the session key and language in the custom LLM extra body", async () => {
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?sig=1', sessionKey: 'session-key-1', locale: 'it' }, callbacks())

    const options = startSession.mock.calls[0][0] as CapturedOptions
    expect(options.signedUrl).toBe('wss://api.elevenlabs.io/v1/convai/conversation?sig=1')
    expect(options.connectionType).toBe('websocket')
    expect(options.customLlmExtraBody).toEqual({ session_key: 'session-key-1', locale: 'it' })
  })

  it('loads its worklets from paths the app host serves', async () => {
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, callbacks())

    const options = startSession.mock.calls[0][0] as CapturedOptions
    for (const path of [...Object.values(options.workletPaths), options.libsampleratePath]) {
      expect(path).toMatch(/^\/voice-worklets\/[a-z-]+\.js$/)
      const name = path.split('/').at(-1)!
      const response = await GET(new Request(`http://app.test${path}`), { params: Promise.resolve({ name }) })
      expect(response.status, path).toBe(200)
    }
  })

  it("reports the vendor's connection, speaker, lines and disconnect, and ends the session", async () => {
    const reported = callbacks()
    const session = await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, reported)
    const options = startSession.mock.calls[0][0] as CapturedOptions

    options.onConnect({ conversationId: 'conv_1' })
    options.onModeChange({ mode: 'speaking' })
    options.onMessage({ message: 'Are you open on Sunday?', role: 'user', event_id: 1, source: 'user' })
    options.onMessage({ message: 'Yes, from ten.', role: 'agent', event_id: 2, source: 'ai', response_id: 'r1' })
    options.onDisconnect({ reason: 'user' })
    await session.end()

    expect(reported.onConnected).toHaveBeenCalledTimes(1)
    expect(reported.onModeChange).toHaveBeenCalledWith('speaking')
    expect(reported.onLine.mock.calls).toEqual([
      [{ speaker: 'caller', text: 'Are you open on Sunday?' }],
      [{ speaker: 'agent', text: 'Yes, from ten.', responseId: 'r1' }],
    ])
    expect(reported.onDisconnected).toHaveBeenCalledTimes(1)
    expect(endSession).toHaveBeenCalledTimes(1)
  })
})
