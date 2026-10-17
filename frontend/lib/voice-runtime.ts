import { voiceVendorNames, type VoiceVendorName } from './api-llm-providers'
import type { VoiceMode } from './voice-session'

/** The voice runtimes the chat panel can open a session on: every vendor the API contract names. */
export type VoiceVendor = VoiceVendorName

export const isVoiceVendor = (value: unknown): value is VoiceVendor =>
  typeof value === 'string' && (voiceVendorNames as readonly string[]).includes(value)

/** One finished line of the call: what the caller said, or the agent's reply. */
export interface VoiceRuntimeLine {
  speaker: 'caller' | 'agent'
  text: string
  /** The vendor's id for one agent reply, when it reports the same reply more than once. */
  responseId?: string
  /** The reply text this line corrects: the caller talked over it, and `text` is what was spoken. */
  corrects?: string
}

/** What a vendor's browser client reports about an open session. */
export interface VoiceRuntimeCallbacks {
  /** The microphone is granted and the vendor's handshake has begun. */
  onConnecting: () => void
  onConnected: () => void
  onModeChange: (mode: VoiceMode) => void
  onLine: (line: VoiceRuntimeLine) => void
  /** The vendor reported an error the call cannot recover from, whether or not it closed the session. */
  onFailed: () => void
  /** The session closed, whoever closed it. */
  onDisconnected: () => void
}

/** The visitor refused the microphone, or the browser has none it can use. */
export class VoiceMicrophoneUnavailableError extends Error {
  constructor() {
    super('The microphone is not available to this page')
    this.name = 'VoiceMicrophoneUnavailableError'
  }
}

export interface VoiceRuntimeSession {
  end: () => Promise<void>
  /** The vendor's own id for the call, once the session is open: it names the call's recording at the vendor. */
  vendorConversationId?: string
}


/**
 * Opens a voice session in the browser on one vendor's agent, with the URL and session key the
 * session start returned. The vendor's client asks for the microphone; `open` rejects with
 * `VoiceMicrophoneUnavailableError` when it cannot have one. Aborting `signal` before the session
 * opens abandons the handshake and releases the microphone. One adapter per vendor implements it;
 * the vendor's client library loads only when a call starts, so the chat panel carries none of it.
 */
export interface VoiceRuntime {
  open: (
    input: { signedUrl: string; sessionKey: string; locale: string },
    callbacks: VoiceRuntimeCallbacks,
    signal: AbortSignal,
  ) => Promise<VoiceRuntimeSession>
}

const VOICE_RUNTIME_LOADERS: Record<VoiceVendor, () => Promise<VoiceRuntime>> = {
  elevenlabs: async () => (await import('./voice-runtime-elevenlabs')).elevenLabsVoiceRuntime,
}

/** Loads every vendor's client: a call learns its vendor from the session start, which comes after. */
export const loadVoiceRuntimes = async (): Promise<Readonly<Record<VoiceVendor, VoiceRuntime>>> => {
  const loaded = await Promise.all(voiceVendorNames.map(async (vendor) => [vendor, await VOICE_RUNTIME_LOADERS[vendor]()] as const))
  return Object.fromEntries(loaded) as Record<VoiceVendor, VoiceRuntime>
}

const IOS_PLATFORMS = ['iPad Simulator', 'iPhone Simulator', 'iPod Simulator', 'iPad', 'iPhone', 'iPod']

/** iPhone, iPad and iPod, including an iPad that reports itself as a Mac with touch. */
const isIosDevice = (): boolean =>
  typeof navigator !== 'undefined'
  && typeof document !== 'undefined'
  && (IOS_PLATFORMS.includes(navigator.platform) || (navigator.userAgent.includes('Mac') && 'ontouchend' in document))

/**
 * Loads the vendor clients ahead of the first call where the browser needs it. On iOS a client,
 * once loaded, creates and unlocks an audio context on the page's first tap and discards it 30
 * seconds later; the call's audio plays through it only if the session opens within that window,
 * so the client must be in the page before the tap on Talk, and the path from the tap to the
 * session must stay short. Everywhere else the client loads when the call starts.
 */
export const prepareVoiceRuntimes = (): void => {
  if (!isIosDevice()) return
  void loadVoiceRuntimes().catch(() => undefined)
}
