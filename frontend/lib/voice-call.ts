import { VoiceMicrophoneUnavailableError, type VoiceRuntime, type VoiceRuntimeLine, type VoiceRuntimeSession, type VoiceVendor } from './voice-runtime'
import type { VoiceSessionEvent } from './voice-session'

/** What the page needs to open the session on the vendor; `signedUrl` is a bearer credential. */
export interface StartedVoiceSession {
  vendor: VoiceVendor
  signedUrl: string
  sessionKey: string
  locale: string
}

/**
 * How a session start ended, as the visitor can act on it. `refused` covers every answer that is
 * not a session (voice off, a start budget spent, a vendor that would not start one, a network
 * that failed): the visitor reads one line for all of them, and the backend's metric says which.
 */
export type VoiceSessionStart = { kind: 'started'; session: StartedVoiceSession } | { kind: 'refused' }

export interface VoiceCallDependencies {
  startSession: () => Promise<VoiceSessionStart>
  /** Every vendor's client: the page learns the call's vendor only from the start, which comes after. */
  loadRuntimes: () => Promise<Readonly<Record<VoiceVendor, VoiceRuntime>>>
  /** Overrides `VOICE_CALL_BEHAVIOR.connectTimeoutMs`, for tests. */
  connectTimeoutMs?: number
}

/**
 * How long a call waits, once the microphone is granted and the vendor's handshake has begun, for
 * the vendor to answer it. Past that the call ends and the handshake is abandoned, which releases
 * the microphone. The vendor's client gives no bound of its own.
 */
export const VOICE_CALL_BEHAVIOR = { connectTimeoutMs: 10_000 } as const

interface VoiceCallObserver {
  onEvent: (event: VoiceSessionEvent) => void
  onLine: (line: VoiceRuntimeLine) => void
}

export interface VoiceCall {
  /** Ends the call wherever it is: while its client loads, while Radioso starts it, while it connects, or live. */
  stop: () => void
}

/**
 * Runs one call, keeping the path from the press to the vendor's audio short (iOS discards the
 * audio context its first tap unlocked after 30 seconds): the vendor's client loads first, so a
 * client that cannot load spends none of the agent's session starts; then the session start; then
 * the vendor's client opens the session and asks for the microphone itself. It reports progress as
 * `VoiceSessionEvent`s and stays silent once stopped, ending a session that opens after the stop.
 */
export function runVoiceCall(dependencies: VoiceCallDependencies, observer: VoiceCallObserver): VoiceCall {
  let stopped = false
  let session: VoiceRuntimeSession | null = null
  let connectTimer: ReturnType<typeof setTimeout> | null = null
  const opening = new AbortController()
  const clearConnectTimer = () => {
    if (connectTimer !== null) clearTimeout(connectTimer)
    connectTimer = null
  }
  const report = (event: VoiceSessionEvent) => {
    if (!stopped) observer.onEvent(event)
  }
  const finish = () => {
    stopped = true
    clearConnectTimer()
    opening.abort()
    void session?.end().catch(() => undefined)
    session = null
  }
  const fail = () => {
    report({ type: 'call_failed' })
    finish()
  }

  const run = async () => {
    let runtimes: Readonly<Record<VoiceVendor, VoiceRuntime>>
    try {
      runtimes = await dependencies.loadRuntimes()
    } catch {
      report({ type: 'start_refused' })
      return
    }
    if (stopped) return

    const start = await dependencies.startSession().catch((): VoiceSessionStart => ({ kind: 'refused' }))
    // Stopped while Radioso started the session: the vendor holds no session yet, so none is
    // opened and the signed URL goes unused until it expires. The start it spent stays spent.
    if (stopped) return
    if (start.kind === 'refused') {
      report({ type: 'start_refused' })
      return
    }

    try {
      const opened = await runtimes[start.session.vendor].open(
        { signedUrl: start.session.signedUrl, sessionKey: start.session.sessionKey, locale: start.session.locale },
        {
          onConnecting: () => {
            if (stopped || connectTimer !== null) return
            connectTimer = setTimeout(fail, dependencies.connectTimeoutMs ?? VOICE_CALL_BEHAVIOR.connectTimeoutMs)
          },
          onConnected: () => {
            clearConnectTimer()
            report({ type: 'connected' })
          },
          onModeChange: (mode) => report({ type: 'mode_changed', mode }),
          onLine: (line) => {
            if (!stopped) observer.onLine(line)
          },
          onFailed: fail,
          onDisconnected: () => report({ type: 'disconnected' }),
        },
        opening.signal,
      )
      // Stopped while the vendor's client opened the session: end the session it opened.
      if (stopped) {
        void opened.end().catch(() => undefined)
        return
      }
      clearConnectTimer()
      session = opened
    } catch (error) {
      clearConnectTimer()
      report({ type: error instanceof VoiceMicrophoneUnavailableError ? 'microphone_refused' : 'start_refused' })
    }
  }

  void run()

  return {
    stop: () => {
      if (stopped) return
      finish()
    },
  }
}

/** The frame's permissions policy, where the browser exposes it (Chromium does). */
type DocumentWithFeaturePolicy = Document & { featurePolicy?: { allowsFeature?: (feature: string) => boolean } }

/**
 * Whether this page can ask for a microphone at all: browsers offer one only to a secure context
 * (https, or localhost) with the media devices API, and only where the permissions policy allows
 * it, which a host page's `Permissions-Policy` header can deny to the frame. A page that cannot ask
 * shows no Talk button.
 */
export function canAskForMicrophone(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext === true
    && typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && (document as DocumentWithFeaturePolicy).featurePolicy?.allowsFeature?.('microphone') !== false
}
