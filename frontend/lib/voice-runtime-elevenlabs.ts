import { Conversation, type Language } from '@elevenlabs/client'

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

type SocketWatcher = { vendorOrigin: string; onSocket: (socket: WebSocket) => void }

/** Calls waiting for their handshake's socket, oldest first; each socket goes to one of them. */
const socketWatchers = new Set<SocketWatcher>()
let installedWatch: { native: typeof WebSocket; watched: typeof WebSocket } | null = null

/**
 * Watches for the WebSocket the client opens to the signed URL's host while `open` runs. The
 * client takes no abort signal, and its handshake waits for the vendor's first message without a
 * bound; closing that socket is what makes it give up and release the microphone. One wrapper
 * over this frame's constructor serves every call that is opening, each socket goes to exactly one
 * of them, and the native constructor comes back when the last one stops watching, so one call's
 * abandon can never reach another call's socket.
 */
const watchVendorSocket = (vendorOrigin: string, onSocket: (socket: WebSocket) => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.WebSocket !== 'function') return () => undefined
  if (!installedWatch) {
    const NativeWebSocket = window.WebSocket
    class WatchedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const origin = new URL(String(url)).origin
        const watcher = [...socketWatchers].find((candidate) => candidate.vendorOrigin === origin)
        if (watcher) {
          socketWatchers.delete(watcher)
          watcher.onSocket(this)
        }
      }
    }
    window.WebSocket = WatchedWebSocket
    installedWatch = { native: NativeWebSocket, watched: WatchedWebSocket }
  }
  const watcher: SocketWatcher = { vendorOrigin, onSocket }
  socketWatchers.add(watcher)
  return () => {
    socketWatchers.delete(watcher)
    if (socketWatchers.size > 0 || !installedWatch) return
    if (window.WebSocket === installedWatch.watched) window.WebSocket = installedWatch.native
    installedWatch = null
  }
}

/**
 * The dynamic variable that carries the privacy notice's line. The vendor agent's first message
 * starts with `{{radioso_privacy_notice}}` for the call to say it before the greeting. Every call the
 * embed starts sets it, empty when no notice applies, so a first message that names it always finds it.
 */
const PRIVACY_NOTICE_VARIABLE = 'radioso_privacy_notice'

/**
 * The session's agent overrides: the first message and the language the start named, and none it
 * did not, since the vendor closes a session that sets one its agent does not allow. The language
 * is the vendor's own code, and Radioso names only codes the client's `Language` type lists, so
 * the start's string is passed on as that type.
 */
const agentOverridesOf = ({ firstMessage, vendorLanguage }: { firstMessage?: string; vendorLanguage?: string }) => {
  if (!firstMessage && !vendorLanguage) return {}
  return {
    overrides: {
      agent: {
        ...(firstMessage ? { firstMessage } : {}),
        ...(vendorLanguage ? { language: vendorLanguage as Language } : {}),
      },
    },
  }
}

/**
 * ElevenLabs Agents in the browser. The session key, the caller's language and the version of the
 * privacy notice the panel showed travel in the custom LLM extra body, where Radioso's `elevenlabs`
 * dialect reads them on every turn; the notice's line is a dynamic variable the first message says.
 * A first message and a language from the session start are the session's overrides, which only an
 * agent that allows them accepts: the vendor closes a session that sets one its agent does not
 * allow, so a session without either sets no override at all.
 */
export const elevenLabsVoiceRuntime: VoiceRuntime = {
  async open({ signedUrl, sessionKey, locale, privacyNotice, firstMessage, vendorLanguage }, callbacks, signal) {
    // Until the session opens, aborting abandons its handshake; once it is open, the session's own
    // `end` closes it.
    let abandonHandshake: (() => void) | null = null
    const stopWatching = watchVendorSocket(new URL(signedUrl).origin, (socket) => {
      stopWatching()
      callbacks.onConnecting()
      // Closed on the next task, once the client has attached its listeners to the socket it is
      // constructing right now, so it hears the close and gives up.
      abandonHandshake = () => {
        setTimeout(() => socket.close(), 0)
      }
      if (signal.aborted) abandonHandshake()
      else signal.addEventListener('abort', abandonHandshake, { once: true })
    })
    try {
      const conversation = await Conversation.startSession({
        signedUrl,
        connectionType: 'websocket',
        customLlmExtraBody: {
          session_key: sessionKey,
          locale,
          ...(privacyNotice ? { privacy_notice_version: privacyNotice.version } : {}),
        },
        dynamicVariables: { [PRIVACY_NOTICE_VARIABLE]: privacyNotice?.text ?? '' },
        ...agentOverridesOf({ firstMessage, vendorLanguage }),
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
      const vendorConversationId = typeof conversation.getId === 'function' ? conversation.getId() : ''
      return { end: () => conversation.endSession(), ...(vendorConversationId ? { vendorConversationId } : {}) }
    } catch (error) {
      if (isMicrophoneError(error)) throw new VoiceMicrophoneUnavailableError()
      throw error
    } finally {
      stopWatching()
      if (abandonHandshake) signal.removeEventListener('abort', abandonHandshake)
    }
  },
}
