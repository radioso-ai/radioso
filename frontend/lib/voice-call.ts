import type { VoiceRuntime, VoiceRuntimeLine, VoiceRuntimeSession, VoiceVendor } from './voice-runtime'
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
  /** Resolves true once the visitor lets the page use a microphone, false when they refuse or have none. */
  requestMicrophone: () => Promise<boolean>
  startSession: () => Promise<VoiceSessionStart>
  loadRuntime: (vendor: VoiceVendor) => Promise<VoiceRuntime>
}

interface VoiceCallObserver {
  onEvent: (event: VoiceSessionEvent) => void
  onLine: (line: VoiceRuntimeLine) => void
}

export interface VoiceCall {
  /** Ends the call wherever it is: before the microphone answers, while it connects, or live. */
  stop: () => void
}

/**
 * Runs one call: the microphone first, so a visitor who refuses it spends none of the agent's
 * session starts; then the session start; then the vendor's runtime with what the start returned.
 * It reports progress as `VoiceSessionEvent`s and stays silent once stopped, ending a session that
 * opens after the stop.
 */
export function runVoiceCall(dependencies: VoiceCallDependencies, observer: VoiceCallObserver): VoiceCall {
  let stopped = false
  let session: VoiceRuntimeSession | null = null
  const report = (event: VoiceSessionEvent) => {
    if (!stopped) observer.onEvent(event)
  }

  const run = async () => {
    const microphoneGranted = await dependencies.requestMicrophone().catch(() => false)
    if (stopped) return
    if (!microphoneGranted) {
      report({ type: 'microphone_refused' })
      return
    }

    const start = await dependencies.startSession().catch((): VoiceSessionStart => ({ kind: 'refused' }))
    // Stopped while Radioso started the session: the vendor holds no session yet, so none is
    // opened and the signed URL goes unused until it expires. The start it spent stays spent.
    if (stopped) return
    if (start.kind === 'refused') {
      report({ type: 'start_refused' })
      return
    }

    try {
      const runtime = await dependencies.loadRuntime(start.session.vendor)
      if (stopped) return
      const opened = await runtime.open(
        { signedUrl: start.session.signedUrl, sessionKey: start.session.sessionKey, locale: start.session.locale },
        {
          onConnected: () => report({ type: 'connected' }),
          onModeChange: (mode) => report({ type: 'mode_changed', mode }),
          onLine: (line) => {
            if (!stopped) observer.onLine(line)
          },
          onDisconnected: () => report({ type: 'disconnected' }),
        },
      )
      // Stopped while the vendor's client opened the session: end the session it opened.
      if (stopped) {
        void opened.end().catch(() => undefined)
        return
      }
      session = opened
    } catch {
      report({ type: 'start_refused' })
    }
  }

  void run()

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      void session?.end().catch(() => undefined)
      session = null
    },
  }
}

/** Asks for the microphone and lets it go at once: the vendor's client opens its own stream. */
export async function requestMicrophoneAccess(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((track) => track.stop())
    return true
  } catch {
    return false
  }
}
