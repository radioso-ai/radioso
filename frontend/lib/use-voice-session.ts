'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { reportVoiceVendorConversation, startPublicVoiceSession } from './api-public-voice'
import { canAskForMicrophone, readMicrophoneSignals, runVoiceCall, type VoiceCall } from './voice-call'
import { loadVoiceRuntimes, prepareVoiceRuntimes, type VoiceCallPrivacyNotice } from './voice-runtime'
import {
  appendVoiceTranscriptLine,
  initialVoiceSessionState,
  isVoiceCallActive,
  voiceSessionReducer,
  type VoiceSessionEvent,
  type VoiceSessionState,
  type VoiceTranscriptLine,
} from './voice-session'

/**
 * One visitor's voice calls from the website embed: the call's visible state, the lines said on
 * it, and Talk and Stop. A call ends when the panel unmounts; the caller ends it on panel close.
 * `precedingMessageIds` reads the chat's message ids, newest first, which each transcript line follows; `offered`
 * says the panel shows Talk, which is when a platform that needs the vendor client early gets it.
 */
export function useVoiceSession({
  token,
  locale,
  privacyNotice,
  precedingMessageIds,
  offered,
}: {
  token: string
  locale?: string
  /** The agent's privacy notice the panel shows; a call starts with it, and its conversation records it. */
  privacyNotice?: VoiceCallPrivacyNotice | null
  precedingMessageIds: () => readonly string[]
  offered: boolean
}) {
  const [state, setState] = useState<VoiceSessionState>(initialVoiceSessionState)
  // The reducer's latest state, read where an event arrives so the call can be stopped the moment
  // the reducer says it is over.
  const stateRef = useRef<VoiceSessionState>(initialVoiceSessionState)
  const apply = useCallback((event: VoiceSessionEvent): VoiceSessionState => {
    const next = voiceSessionReducer(stateRef.current, event)
    stateRef.current = next
    setState(next)
    return next
  }, [])
  const [lines, setLines] = useState<readonly VoiceTranscriptLine[]>([])
  // The agent's line telling the caller the call is recorded, from the current call's start.
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null)
  const callRef = useRef<VoiceCall | null>(null)
  // The last call's `settled`: a new call waits for it, so a call stopped while its vendor still
  // connects has let go of the microphone and its session before the next one asks for either.
  const lastSettledRef = useRef<Promise<void>>(Promise.resolve())
  const lineCountRef = useRef(0)

  const stop = useCallback(() => {
    callRef.current?.stop()
    callRef.current = null
    apply({ type: 'stop_pressed' })
  }, [apply])

  /** Ends any call and forgets what was said: the conversation it belonged to was cleared. */
  const reset = useCallback(() => {
    callRef.current?.stop()
    callRef.current = null
    setLines([])
    setRecordingNotice(null)
    apply({ type: 'reset' })
  }, [apply])

  const talk = useCallback(() => {
    if (callRef.current) return
    apply({ type: 'talk_pressed' })
    setRecordingNotice(null)
    const call = runVoiceCall(
      {
        startSession: async () => {
          const start = await startPublicVoiceSession(token, { locale })
          if (start.kind === 'started' && callRef.current === call) setRecordingNotice(start.session.recordingNotice ?? null)
          return start.kind === 'started' && privacyNotice
            ? { ...start, session: { ...start.session, privacyNotice: { text: privacyNotice.text, version: privacyNotice.version } } }
            : start
        },
        loadRuntimes: loadVoiceRuntimes,
        after: lastSettledRef.current,
        reportVendorConversation: (report) => reportVoiceVendorConversation(token, report),
      },
      {
        onEvent: (event) => {
          // The reducer decides when a call is over; then nothing the vendor still delivers counts,
          // and a new press may start another call.
          if (!isVoiceCallActive(apply(event))) {
            call.stop()
            if (callRef.current === call) callRef.current = null
          }
        },
        onLine: (line) => {
          if (!line.text.trim() && line.corrects === undefined) return
          lineCountRef.current += 1
          const id = `voice-line-${lineCountRef.current}`
          const afterMessageIds = precedingMessageIds()
          setLines((current) => appendVoiceTranscriptLine(current, { ...line, id, afterMessageIds }))
        },
      },
    )
    callRef.current = call
    lastSettledRef.current = call.settled
  }, [apply, locale, precedingMessageIds, privacyNotice, token])

  useEffect(() => {
    if (offered) prepareVoiceRuntimes()
  }, [offered])

  useEffect(() => () => {
    callRef.current?.stop()
    callRef.current = null
  }, [])

  return { state, lines, recordingNotice, isActive: isVoiceCallActive(state), talk, stop, reset }
}

/**
 * Whether the frame can ask for a microphone, read once the panel would offer Talk: false until
 * the browser has answered, so Talk never shows for a moment on a page that cannot use it.
 */
export function useCanAskForMicrophone(wanted: boolean): boolean {
  const [canAsk, setCanAsk] = useState(false)
  useEffect(() => {
    if (!wanted) return
    let active = true
    void readMicrophoneSignals().then((signals) => {
      if (active) setCanAsk(canAskForMicrophone(signals))
    })
    return () => {
      active = false
    }
  }, [wanted])
  return wanted && canAsk
}
