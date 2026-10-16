import type { VoiceVendor } from './api-public-voice'
import type { VoiceMode } from './voice-session'

/** One finished line of the call: what the caller said, or the agent's reply. */
export interface VoiceRuntimeLine {
  speaker: 'caller' | 'agent'
  text: string
  /** The vendor's id for one agent reply, when it reports the same reply more than once. */
  responseId?: string
}

/** What a vendor's browser client reports about an open session. */
export interface VoiceRuntimeCallbacks {
  onConnected: () => void
  onModeChange: (mode: VoiceMode) => void
  onLine: (line: VoiceRuntimeLine) => void
  /** The session closed, whoever closed it. */
  onDisconnected: () => void
}

export interface VoiceRuntimeSession {
  end: () => Promise<void>
}

/**
 * Opens a voice session in the browser on one vendor's agent, with the URL and session key the
 * session start returned. One adapter per vendor implements it; the vendor's client library loads
 * only when a call starts, so the chat panel carries none of it.
 */
export interface VoiceRuntime {
  open: (
    input: { signedUrl: string; sessionKey: string; locale: string },
    callbacks: VoiceRuntimeCallbacks,
  ) => Promise<VoiceRuntimeSession>
}

const VOICE_RUNTIME_LOADERS: Record<VoiceVendor, () => Promise<VoiceRuntime>> = {
  elevenlabs: async () => (await import('./voice-runtime-elevenlabs')).elevenLabsVoiceRuntime,
}

/**
 * A runtime that a script on the chat frame's own origin installed in place of the vendor's. The
 * end-to-end tests install one so they can drive a call without a vendor; a host page cannot reach
 * the frame's window, so it cannot install one.
 */
const RUNTIME_OVERRIDE_KEY = '__radiosoVoiceRuntime'

const installedRuntime = (): VoiceRuntime | null => {
  if (typeof window === 'undefined') return null
  const candidate = (window as unknown as Record<string, unknown>)[RUNTIME_OVERRIDE_KEY]
  return candidate && typeof candidate === 'object' && typeof (candidate as VoiceRuntime).open === 'function'
    ? (candidate as VoiceRuntime)
    : null
}

export const loadVoiceRuntime = (vendor: VoiceVendor): Promise<VoiceRuntime> => {
  const installed = installedRuntime()
  return installed ? Promise.resolve(installed) : VOICE_RUNTIME_LOADERS[vendor]()
}
