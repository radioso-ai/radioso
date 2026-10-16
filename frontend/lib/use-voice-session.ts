'use client'

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import { startPublicVoiceSession } from './api-public-voice'
import { runVoiceCall, type VoiceCall } from './voice-call'
import { loadVoiceRuntimes, prepareVoiceRuntimes } from './voice-runtime'
import {
  appendVoiceTranscriptLine,
  initialVoiceSessionState,
  isVoiceCallActive,
  voiceSessionReducer,
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
  precedingMessageIds,
  offered,
}: {
  token: string
  locale?: string
  precedingMessageIds: () => readonly string[]
  offered: boolean
}) {
  const [state, dispatch] = useReducer(voiceSessionReducer, initialVoiceSessionState)
  const [lines, setLines] = useState<readonly VoiceTranscriptLine[]>([])
  const callRef = useRef<VoiceCall | null>(null)
  const lineCountRef = useRef(0)

  const stop = useCallback(() => {
    callRef.current?.stop()
    callRef.current = null
    dispatch({ type: 'stop_pressed' })
  }, [])

  /** Ends any call and forgets what was said: the conversation it belonged to was cleared. */
  const reset = useCallback(() => {
    callRef.current?.stop()
    callRef.current = null
    setLines([])
    dispatch({ type: 'reset' })
  }, [])

  const talk = useCallback(() => {
    if (callRef.current) return
    dispatch({ type: 'talk_pressed' })
    const call = runVoiceCall(
      {
        startSession: () => startPublicVoiceSession(token, { locale }),
        loadRuntimes: loadVoiceRuntimes,
      },
      {
        onEvent: (event) => {
          // A call that failed or dropped is over: stopping it drops whatever the vendor still
          // delivers, and a new press may start another.
          if (event.type === 'microphone_refused' || event.type === 'start_refused' || event.type === 'call_failed' || event.type === 'disconnected') {
            call.stop()
            if (callRef.current === call) callRef.current = null
          }
          dispatch(event)
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
  }, [locale, precedingMessageIds, token])

  useEffect(() => {
    if (offered) prepareVoiceRuntimes()
  }, [offered])

  useEffect(() => () => {
    callRef.current?.stop()
    callRef.current = null
  }, [])

  return { state, lines, isActive: isVoiceCallActive(state), talk, stop, reset }
}
