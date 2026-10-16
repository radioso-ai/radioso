'use client'

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import { startPublicVoiceSession } from './api-public-voice'
import { requestMicrophoneAccess, runVoiceCall, type VoiceCall } from './voice-call'
import { loadVoiceRuntime } from './voice-runtime'
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
 * `currentMessageId` reads the newest chat message, which each transcript line follows.
 */
export function useVoiceSession({
  token,
  locale,
  currentMessageId,
}: {
  token: string
  locale?: string
  currentMessageId: () => string | null
}) {
  const [state, dispatch] = useReducer(voiceSessionReducer, initialVoiceSessionState)
  const [lines, setLines] = useState<VoiceTranscriptLine[]>([])
  const callRef = useRef<VoiceCall | null>(null)
  const lineCountRef = useRef(0)
  const currentMessageIdRef = useRef(currentMessageId)
  useEffect(() => {
    currentMessageIdRef.current = currentMessageId
  }, [currentMessageId])

  const stop = useCallback(() => {
    callRef.current?.stop()
    callRef.current = null
    dispatch({ type: 'stop_pressed' })
  }, [])

  const talk = useCallback(() => {
    if (callRef.current) return
    dispatch({ type: 'talk_pressed' })
    const call = runVoiceCall(
      {
        requestMicrophone: requestMicrophoneAccess,
        startSession: () => startPublicVoiceSession(token, { locale }),
        loadRuntime: loadVoiceRuntime,
      },
      {
        onEvent: (event) => {
          // A call that failed or dropped is over: a new press may start another.
          if (event.type === 'microphone_refused' || event.type === 'start_refused' || event.type === 'disconnected') {
            if (callRef.current === call) callRef.current = null
          }
          dispatch(event)
        },
        onLine: (line) => {
          lineCountRef.current += 1
          const id = `voice-line-${lineCountRef.current}`
          const afterMessageId = currentMessageIdRef.current()
          setLines((current) => appendVoiceTranscriptLine(current, { ...line, id, afterMessageId }))
        },
      },
    )
    callRef.current = call
  }, [locale, token])

  useEffect(() => () => {
    callRef.current?.stop()
    callRef.current = null
  }, [])

  return { state, lines, isActive: isVoiceCallActive(state), talk, stop }
}
