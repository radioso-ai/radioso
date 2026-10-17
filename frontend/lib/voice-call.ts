import type { VoiceVendorConversationReportOutcome } from './api-public-voice'
import type { PublicVoiceSessionResponse } from './api-types'
import { VoiceMicrophoneUnavailableError, type VoiceRuntime, type VoiceRuntimeLine, type VoiceRuntimeSession, type VoiceVendor } from './voice-runtime'
import type { VoiceSessionEvent } from './voice-session'

/**
 * What the page needs to open the session on the vendor, from the start's answer; `signedUrl` is a
 * bearer credential. `recordingNotice` is the agent's line telling the caller the call is recorded.
 */
export type StartedVoiceSession = Pick<PublicVoiceSessionResponse, 'vendor' | 'signedUrl' | 'sessionKey' | 'locale' | 'recordingNotice'>

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
  /**
   * The previous call's `settled`: this call touches nothing until that one has let go of the
   * microphone and its session, so two calls never hold either at once.
   */
  after?: Promise<void>
  /**
   * Tells Radioso the vendor's id for the call once the session is open, so the call's recording can
   * be found, and once more as the session ends when that report did not get through. The call never
   * waits for it, and a report that fails changes nothing about the call.
   */
  reportVendorConversation?: (input: { sessionKey: string; vendorConversationId: string }) => Promise<VoiceVendorConversationReportOutcome>
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
  /**
   * Resolves once the call can touch nothing more: it never opened a session, or the session it
   * opened has ended. A call stopped while its vendor still connects settles when that handshake
   * gives up or opens and is ended.
   */
  settled: Promise<void>
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
  let sessionClosed: Promise<void> = Promise.resolve()
  let closeSession: (() => void) | null = null
  let connectTimer: ReturnType<typeof setTimeout> | null = null
  // The open session's report, until the session ends.
  let vendorReport: { input: { sessionKey: string; vendorConversationId: string }; outcome: Promise<VoiceVendorConversationReportOutcome> } | null = null
  const opening = new AbortController()
  const clearConnectTimer = () => {
    if (connectTimer !== null) clearTimeout(connectTimer)
    connectTimer = null
  }
  const report = (event: VoiceSessionEvent) => {
    if (!stopped) observer.onEvent(event)
  }
  /** As the session ends: a report that did not get through goes once more; a 204 or a refusal is final. */
  const settleVendorReport = () => {
    const pending = vendorReport
    const report = dependencies.reportVendorConversation
    vendorReport = null
    if (!pending || !report) return
    void pending.outcome
      .then((outcome) => (outcome === 'failed' ? report(pending.input) : outcome))
      .catch(() => undefined)
  }
  const finish = () => {
    if (stopped) return
    stopped = true
    clearConnectTimer()
    opening.abort()
    settleVendorReport()
    const open = session
    session = null
    if (open) void open.end().catch(() => undefined).finally(() => closeSession?.())
  }
  const fail = () => {
    report({ type: 'call_failed' })
    finish()
  }

  const run = async () => {
    await dependencies.after
    if (stopped) return

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
          onDisconnected: () => {
            report({ type: 'disconnected' })
            finish()
          },
        },
        opening.signal,
      )
      // Stopped while the vendor's client opened the session: end the session it opened, once
      // Radioso has been told which call it was, so its recording is not left without a record.
      if (stopped) {
        if (opened.vendorConversationId && dependencies.reportVendorConversation) {
          void dependencies
            .reportVendorConversation({ sessionKey: start.session.sessionKey, vendorConversationId: opened.vendorConversationId })
            .catch(() => undefined)
        }
        await opened.end().catch(() => undefined)
        return
      }
      clearConnectTimer()
      session = opened
      sessionClosed = new Promise<void>((resolve) => {
        closeSession = resolve
      })
      if (opened.vendorConversationId && dependencies.reportVendorConversation) {
        const input = { sessionKey: start.session.sessionKey, vendorConversationId: opened.vendorConversationId }
        vendorReport = { input, outcome: dependencies.reportVendorConversation(input).catch((): VoiceVendorConversationReportOutcome => 'failed') }
      }
    } catch (error) {
      clearConnectTimer()
      report({ type: error instanceof VoiceMicrophoneUnavailableError ? 'microphone_refused' : 'start_refused' })
    }
  }

  const settled = run().catch(() => undefined).then(() => sessionClosed)

  return { stop: finish, settled }
}

/** The frame's permissions policy, where the browser exposes it (Chromium does). */
type DocumentWithFeaturePolicy = Document & { featurePolicy?: { allowsFeature?: (feature: string) => boolean } }

/** What the page knows about whether it may use a microphone. */
interface MicrophoneSignals {
  secureContext: boolean
  mediaDevices: boolean
  /** The frame's permissions policy for the microphone, where the browser exposes it. */
  policyAllows?: boolean
  /** The microphone permission's state, where the browser answers the query. */
  permission?: PermissionState
}

/**
 * Whether this page can ask for a microphone at all: browsers offer one only to a secure context
 * (https, or localhost) with the media devices API, and only where the permissions policy allows
 * it, which a host page's `Permissions-Policy` header can deny to the frame. Where the browser does
 * not expose the policy, a denied microphone permission stands for it; where it exposes neither, the
 * page can ask, and a refusal reads as the microphone line. A page that cannot ask shows no Talk.
 */
export function canAskForMicrophone(signals: MicrophoneSignals): boolean {
  if (!signals.secureContext || !signals.mediaDevices) return false
  if (signals.policyAllows !== undefined) return signals.policyAllows
  return signals.permission !== 'denied'
}

// The DOM typings this frontend builds with do not list the microphone permission, which the
// browsers that answer the query know.
const MICROPHONE_PERMISSION = { name: 'microphone' } as unknown as PermissionDescriptor

/** Reads the signals `canAskForMicrophone` decides on; the permission query only where the policy is unknown. */
export async function readMicrophoneSignals(): Promise<MicrophoneSignals> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return { secureContext: false, mediaDevices: false }
  const featurePolicy = (document as DocumentWithFeaturePolicy).featurePolicy
  const policyAllows = typeof featurePolicy?.allowsFeature === 'function' ? featurePolicy.allowsFeature('microphone') : undefined
  const signals: MicrophoneSignals = {
    secureContext: window.isSecureContext === true,
    mediaDevices: typeof navigator.mediaDevices?.getUserMedia === 'function',
    ...(policyAllows === undefined ? {} : { policyAllows }),
  }
  if (policyAllows !== undefined || typeof navigator.permissions?.query !== 'function') return signals
  try {
    const status = await navigator.permissions.query(MICROPHONE_PERMISSION)
    return { ...signals, permission: status.state }
  } catch {
    // A browser that does not know the microphone permission answers nothing about it.
    return signals
  }
}
