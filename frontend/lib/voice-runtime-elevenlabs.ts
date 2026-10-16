import { Conversation } from '@elevenlabs/client'

import { VoiceMicrophoneUnavailableError, type VoiceRuntime } from './voice-runtime'

/**
 * The client's audio worklets, served from the app host (`app/voice-worklets/[name]/route.ts`).
 * The chat frame's content security policy loads scripts from its own origin only, so the client's
 * default of loading them from `blob:` and `data:` URLs, and the resampler from a CDN, would fail.
 */
const WORKLET_PATHS = {
  rawAudioProcessor: '/voice-worklets/raw-audio-processor.js',
  audioConcatProcessor: '/voice-worklets/audio-concat-processor.js',
}
const LIBSAMPLERATE_PATH = '/voice-worklets/libsamplerate.js'

/** What `getUserMedia` rejects with when the page cannot have a microphone. */
const MICROPHONE_ERROR_NAMES = new Set(['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError'])

const isMicrophoneError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && MICROPHONE_ERROR_NAMES.has(String(error.name))

/**
 * Watches for the WebSocket the client opens to the signed URL's host while `open` runs. The
 * client takes no abort signal, and its handshake waits for the vendor's first message without a
 * bound; closing that socket is what makes it give up and release the microphone. Only this frame's
 * own constructor is wrapped, only for the call's handshake, and only sockets to the vendor's host
 * are touched.
 */
const watchVendorSocket = (vendorOrigin: string, onSocket: (socket: WebSocket) => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.WebSocket !== 'function') return () => undefined
  const NativeWebSocket = window.WebSocket
  class WatchedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      if (new URL(String(url)).origin === vendorOrigin) onSocket(this)
    }
  }
  window.WebSocket = WatchedWebSocket
  return () => {
    if (window.WebSocket === WatchedWebSocket) window.WebSocket = NativeWebSocket
  }
}

/**
 * ElevenLabs Agents in the browser. The session key and the caller's language travel in the
 * custom LLM extra body, where Radioso's `elevenlabs` dialect reads them on every turn.
 */
export const elevenLabsVoiceRuntime: VoiceRuntime = {
  async open({ signedUrl, sessionKey, locale }, callbacks, signal) {
    // Until the session opens, aborting abandons its handshake; once it is open, the session's own
    // `end` closes it.
    let abandonHandshake: (() => void) | null = null
    const stopWatching = watchVendorSocket(new URL(signedUrl).origin, (socket) => {
      stopWatching()
      callbacks.onConnecting()
      abandonHandshake = () => socket.close()
      if (signal.aborted) abandonHandshake()
      else signal.addEventListener('abort', abandonHandshake, { once: true })
    })
    try {
      const conversation = await Conversation.startSession({
        signedUrl,
        connectionType: 'websocket',
        customLlmExtraBody: { session_key: sessionKey, locale },
        workletPaths: WORKLET_PATHS,
        libsampleratePath: LIBSAMPLERATE_PATH,
        onConnect: () => callbacks.onConnected(),
        onModeChange: ({ mode }) => callbacks.onModeChange(mode),
        onMessage: ({ role, message, response_id: responseId }) =>
          callbacks.onLine({ speaker: role === 'user' ? 'caller' : 'agent', text: message, ...(responseId ? { responseId } : {}) }),
        // A reply the caller talked over arrives again here, cut to what was actually spoken.
        onAgentResponseCorrection: ({ original_agent_response: original, corrected_agent_response: corrected, response_id: responseId }) =>
          callbacks.onLine({ speaker: 'agent', text: corrected, corrects: original, ...(responseId ? { responseId } : {}) }),
        onError: () => callbacks.onFailed(),
        onDisconnect: () => callbacks.onDisconnected(),
      })
      return { end: () => conversation.endSession() }
    } catch (error) {
      if (isMicrophoneError(error)) throw new VoiceMicrophoneUnavailableError()
      throw error
    } finally {
      stopWatching()
      if (abandonHandshake) signal.removeEventListener('abort', abandonHandshake)
    }
  },
}
