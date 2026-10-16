import type { VoiceMode } from './voice-session'

/** The voice runtimes the chat panel can open a session on. */
const VOICE_VENDORS = ['elevenlabs'] as const

export type VoiceVendor = (typeof VOICE_VENDORS)[number]

export const isVoiceVendor = (value: unknown): value is VoiceVendor =>
  typeof value === 'string' && (VOICE_VENDORS as readonly string[]).includes(value)

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

export const loadVoiceRuntime = (vendor: VoiceVendor): Promise<VoiceRuntime> => VOICE_RUNTIME_LOADERS[vendor]()

const IOS_PLATFORMS = ['iPad Simulator', 'iPhone Simulator', 'iPod Simulator', 'iPad', 'iPhone', 'iPod']

/** iPhone, iPad and iPod, including an iPad that reports itself as a Mac with touch. */
const isIosDevice = (): boolean =>
  typeof navigator !== 'undefined'
  && typeof document !== 'undefined'
  && (IOS_PLATFORMS.includes(navigator.platform) || (navigator.userAgent.includes('Mac') && 'ontouchend' in document))

/**
 * Loads the vendor clients ahead of the first call where the browser needs it. On iOS a client
 * unlocks audio during the tap that starts a call, and only a client already in the page sees
 * that tap; everywhere else the client loads when the call starts.
 */
export const prepareVoiceRuntimes = (): void => {
  if (!isIosDevice()) return
  for (const vendor of VOICE_VENDORS) {
    void loadVoiceRuntime(vendor).catch(() => undefined)
  }
}
