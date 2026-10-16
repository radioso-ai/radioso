import { Conversation } from '@elevenlabs/client'

import type { VoiceRuntime } from './voice-runtime'

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

/**
 * ElevenLabs Agents in the browser. The session key and the caller's language travel in the
 * custom LLM extra body, where Radioso's `elevenlabs` dialect reads them on every turn.
 */
export const elevenLabsVoiceRuntime: VoiceRuntime = {
  async open({ signedUrl, sessionKey, locale }, callbacks) {
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
      onDisconnect: () => callbacks.onDisconnected(),
    })
    return { end: () => conversation.endSession() }
  },
}
