'use client'

import { Mic, PhoneOff } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { WebsiteEmbedCopy, WebsiteEmbedTheme } from '@/lib/embed-widget'
import type { VoiceSessionState } from '@/lib/voice-session'

/** The composer's Talk button: it starts a voice call with the agent. */
export function VoiceTalkButton({
  theme,
  copy,
  onPress,
  disabled = false,
}: {
  theme: WebsiteEmbedTheme
  copy: WebsiteEmbedCopy
  onPress: () => void
  /** While the chat loads, a typed reply streams, or the agent is unavailable. */
  disabled?: boolean
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="h-9 w-9 shrink-0 rounded-full hover:opacity-80"
      onClick={onPress}
      disabled={disabled}
      title={copy.publicChatTalkLabel}
      style={{ color: theme.inputForeground }}
    >
      <Mic className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{copy.publicChatTalkLabel}</span>
    </Button>
  )
}

const liveStatusText = (state: VoiceSessionState, copy: WebsiteEmbedCopy): string => {
  if (state.status === 'live') {
    return state.mode === 'speaking' ? copy.publicChatVoiceSpeakingStatus : copy.publicChatVoiceListeningStatus
  }
  return copy.publicChatVoiceConnectingStatus
}

/** Stands in for the composer while a call connects or runs: who is talking, and End call. */
export function VoiceCallBar({
  theme,
  copy,
  state,
  onStop,
}: {
  theme: WebsiteEmbedTheme
  copy: WebsiteEmbedCopy
  state: VoiceSessionState
  onStop: () => void
}) {
  const speaking = state.status === 'live' && state.mode === 'speaking'
  return (
    <div className="mx-auto max-w-3xl">
      <div
        className="flex items-center gap-3 rounded-3xl border px-3 py-1.5"
        style={{ background: theme.inputBackground, borderColor: theme.inputBorder, color: theme.inputForeground }}
      >
        <span
          aria-hidden="true"
          className={`size-2.5 shrink-0 rounded-full ${state.status === 'connecting' || speaking ? 'animate-pulse' : ''}`}
          style={{ background: speaking ? theme.accent : theme.mutedForeground }}
        />
        <p role="status" aria-live="polite" className="min-w-0 flex-1 truncate text-sm">
          {liveStatusText(state, copy)}
        </p>
        <Button
          type="button"
          size="sm"
          className="h-9 shrink-0 gap-1.5 rounded-full px-3 hover:opacity-90"
          onClick={onStop}
          style={{ background: theme.accent, color: theme.accentForeground }}
        >
          <PhoneOff className="h-4 w-4" aria-hidden="true" />
          {copy.publicChatEndCallLabel}
        </Button>
      </div>
    </div>
  )
}

/** The one line a call leaves behind once it is over: it ended, or why it never started. */
export function VoiceCallNotice({
  theme,
  copy,
  state,
}: {
  theme: WebsiteEmbedTheme
  copy: WebsiteEmbedCopy
  state: VoiceSessionState
}) {
  const text =
    state.status === 'ended'
      ? copy.publicChatVoiceEndedStatus
      : state.status === 'failed'
        ? state.problem === 'microphone'
          ? copy.publicChatVoiceMicrophoneError
          : copy.publicChatVoiceUnavailableError
        : null
  if (!text) return null
  return (
    <p role="status" className="mx-auto mb-1.5 max-w-3xl px-2 text-xs" style={{ color: theme.mutedForeground }}>
      {text}
    </p>
  )
}
