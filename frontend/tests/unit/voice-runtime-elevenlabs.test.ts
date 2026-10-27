import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const startSession = vi.fn()
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: (options: unknown) => startSession(options) } }))

import { GET } from '@/app/voice-worklets/[name]/route'
import { VoiceMicrophoneUnavailableError } from '@/lib/voice-runtime'
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
  onAgentResponseCorrection: (props: { original_agent_response: string; corrected_agent_response: string; event_id: number; response_id?: string }) => void
  onError: (message: string, context?: unknown) => void
}

const callbacks = () => ({ onConnecting: vi.fn(), onConnected: vi.fn(), onModeChange: vi.fn(), onLine: vi.fn(), onFailed: vi.fn(), onDisconnected: vi.fn() })
const openSignal = () => new AbortController().signal
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Stands in for the browser's WebSocket so the adapter's handshake watch can be observed. */
class FakeWebSocket {
  static created: FakeWebSocket[] = []
  closed = 0
  constructor(readonly url: string | URL) {
    FakeWebSocket.created.push(this)
  }
  close() {
    this.closed += 1
  }
}

describe('ElevenLabs voice runtime', () => {
  const endSession = vi.fn(async () => undefined)
  beforeEach(() => {
    startSession.mockReset()
    startSession.mockResolvedValue({ endSession })
    FakeWebSocket.created = []
    vi.stubGlobal('window', { WebSocket: FakeWebSocket })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("opens the signed URL over a websocket with the session key and language in the custom LLM extra body", async () => {
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?sig=1', sessionKey: 'session-key-1', locale: 'it' }, callbacks(), openSignal())

    const options = startSession.mock.calls[0][0] as CapturedOptions
    expect(options.signedUrl).toBe('wss://api.elevenlabs.io/v1/convai/conversation?sig=1')
    expect(options.connectionType).toBe('websocket')
    expect(options.customLlmExtraBody).toEqual({ session_key: 'session-key-1', locale: 'it' })
  })

  it("hands the call the privacy notice the panel showed: its line to say, its version to record (#1545)", async () => {
    const notice = { text: 'We use your messages to answer you.', version: 'en:0123456789abcdef' }
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en', privacyNotice: notice }, callbacks(), openSignal())

    const options = startSession.mock.calls[0][0] as CapturedOptions & { dynamicVariables?: Record<string, string> }
    expect(options.customLlmExtraBody).toEqual({ session_key: 'k', locale: 'en', privacy_notice_version: notice.version })
    expect(options.dynamicVariables).toEqual({ radioso_privacy_notice: notice.text })

    // With no notice the variable is still set, empty, so a first message that names it never meets a missing one.
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, callbacks(), openSignal())
    expect((startSession.mock.calls[1][0] as { dynamicVariables?: unknown }).dynamicVariables).toEqual({ radioso_privacy_notice: '' })
    expect((startSession.mock.calls[1][0] as CapturedOptions).customLlmExtraBody).toEqual({ session_key: 'k', locale: 'en' })
  })

  it("opens the call with the start's first message as the session's override, and sets none without one", async () => {
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'it', firstMessage: 'Ciao! Sono Marta.' }, callbacks(), openSignal())
    expect((startSession.mock.calls[0][0] as { overrides?: unknown }).overrides).toEqual({ agent: { firstMessage: 'Ciao! Sono Marta.' } })

    // An agent set up outside Radioso closes a session that sets a first message it does not allow.
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'it' }, callbacks(), openSignal())
    expect(startSession.mock.calls[1][0]).not.toHaveProperty('overrides')
  })

  it("names the vendor's id for the call once the session is open, and none when the client has none", async () => {
    startSession.mockResolvedValueOnce({ endSession, getId: () => 'conv_01jx8k2m' })
    const named = await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, callbacks(), openSignal())
    expect(named.vendorConversationId).toBe('conv_01jx8k2m')

    startSession.mockResolvedValueOnce({ endSession, getId: () => '' })
    const unnamed = await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, callbacks(), openSignal())
    expect(unnamed.vendorConversationId).toBeUndefined()
  })

  it('loads its worklets from paths the app host serves', async () => {
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, callbacks(), openSignal())

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
    const session = await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, reported, openSignal())
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

  it('reports a reply the caller talked over as a line that corrects it to what was spoken', async () => {
    const reported = callbacks()
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, reported, openSignal())
    const options = startSession.mock.calls[0][0] as CapturedOptions

    options.onAgentResponseCorrection({ original_agent_response: 'We open at ten and close at four.', corrected_agent_response: 'We open at ten', event_id: 3, response_id: 'r1' })
    options.onAgentResponseCorrection({ original_agent_response: 'Sure, one moment.', corrected_agent_response: 'Sure', event_id: 5 })

    expect(reported.onLine.mock.calls).toEqual([
      [{ speaker: 'agent', text: 'We open at ten', corrects: 'We open at ten and close at four.', responseId: 'r1' }],
      [{ speaker: 'agent', text: 'Sure', corrects: 'Sure, one moment.' }],
    ])
  })

  it("fails the call on a vendor error event, which may leave the socket open", async () => {
    const reported = callbacks()
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, reported, openSignal())
    const options = startSession.mock.calls[0][0] as CapturedOptions

    options.onError('Server error', { reason: 'quota' })

    expect(reported.onFailed).toHaveBeenCalledTimes(1)
  })

  it.each(['NotAllowedError', 'NotFoundError', 'NotReadableError'])("reads the client's %s as an unavailable microphone", async (name) => {
    startSession.mockRejectedValue(Object.assign(new Error('getUserMedia failed'), { name }))

    await expect(elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, callbacks(), openSignal()))
      .rejects.toBeInstanceOf(VoiceMicrophoneUnavailableError)
  })

  it('passes any other failure through', async () => {
    startSession.mockRejectedValue(new Error('Connection closed unexpectedly before session could be established.'))

    await expect(elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, callbacks(), openSignal()))
      .rejects.not.toBeInstanceOf(VoiceMicrophoneUnavailableError)
  })

  it("reports the vendor's handshake once its socket opens, and closes that socket alone when the call is abandoned", async () => {
    const reported = callbacks()
    const abandon = new AbortController()
    const opening = new Promise((resolve) => {
      startSession.mockImplementation(async () => {
        const vendorSocket = new window.WebSocket('wss://vendor.test/v1/convai/conversation?sig=1')
        const otherSocket = new window.WebSocket('wss://elsewhere.test/live')
        resolve({ vendorSocket, otherSocket })
        return new Promise(() => undefined)
      })
    })
    void elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test/v1/convai/conversation?sig=1', sessionKey: 'k', locale: 'en' }, reported, abandon.signal)
    const { vendorSocket, otherSocket } = (await opening) as { vendorSocket: FakeWebSocket; otherSocket: FakeWebSocket }

    expect(reported.onConnecting).toHaveBeenCalledTimes(1)
    abandon.abort()
    await nextTask()

    expect(vendorSocket.closed).toBe(1)
    expect(otherSocket.closed).toBe(0)
  })

  it('leaves an open session to its own end: aborting after it opened closes nothing', async () => {
    const abandon = new AbortController()
    let vendorSocket: FakeWebSocket | null = null
    startSession.mockImplementation(async () => {
      vendorSocket = new window.WebSocket('wss://vendor.test/v1/convai/conversation') as unknown as FakeWebSocket
      return { endSession }
    })
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test/v1/convai/conversation', sessionKey: 'k', locale: 'en' }, callbacks(), abandon.signal)

    abandon.abort()

    expect(vendorSocket!.closed).toBe(0)
  })

  it("keeps two overlapping calls apart: one call's abandon closes only its own socket, and the native constructor comes back", async () => {
    const firstAbandon = new AbortController()
    const secondAbandon = new AbortController()
    const firstConnecting = callbacks()
    const secondConnecting = callbacks()
    const sockets: FakeWebSocket[] = []
    const gates: Array<() => void> = []
    startSession.mockImplementation(async (options: { signedUrl: string }) => {
      await new Promise<void>((release) => gates.push(release))
      sockets.push(new window.WebSocket(options.signedUrl) as unknown as FakeWebSocket)
      return { endSession }
    })

    const first = elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test/one', sessionKey: 'k1', locale: 'en' }, firstConnecting, firstAbandon.signal)
    const second = elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test/two', sessionKey: 'k2', locale: 'en' }, secondConnecting, secondAbandon.signal)
    firstAbandon.abort()
    gates[0]()
    gates[1]()
    await Promise.all([first, second])
    await nextTask()

    expect(sockets).toHaveLength(2)
    expect(sockets.map((socket) => socket.closed)).toEqual([1, 0])
    expect(firstConnecting.onConnecting).toHaveBeenCalledTimes(1)
    expect(secondConnecting.onConnecting).toHaveBeenCalledTimes(1)
    expect(window.WebSocket).toBe(FakeWebSocket)
  })

  it("restores the frame's WebSocket once the session is open", async () => {
    await elevenLabsVoiceRuntime.open({ signedUrl: 'wss://vendor.test', sessionKey: 'k', locale: 'en' }, callbacks(), openSignal())

    expect(window.WebSocket).toBe(FakeWebSocket)
  })
})
