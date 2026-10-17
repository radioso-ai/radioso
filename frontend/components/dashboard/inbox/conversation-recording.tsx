'use client'

import { useState } from 'react'
import { Headphones } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { API_BASE } from '@/lib/api-client'

/**
 * Where the Inbox plays a voice conversation's recording: the backend streams it from the voice
 * vendor. An `<audio>` element cannot send the workspace header, so the workspace travels as a
 * query selector the backend checks against the session.
 */
export const conversationRecordingUrl = (workspaceId: string, conversationId: string): string =>
  `${API_BASE}/conversations/${encodeURIComponent(conversationId)}/recording?workspaceId=${encodeURIComponent(workspaceId)}`

/** The header's Listen button, shown when the conversation's detail says the call has a recording. */
export function ListenToRecordingButton({ listening, onToggle }: { listening: boolean; onToggle: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" aria-pressed={listening} onClick={onToggle}>
      <Headphones className="h-3.5 w-3.5" aria-hidden />
      Listen
    </Button>
  )
}

/**
 * The call's audio, streamed when the teammate presses Listen and never before: each play is
 * audited against them.
 */
export function ConversationRecordingPlayer({ workspaceId, conversationId }: { workspaceId: string; conversationId: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="shrink-0 border-b border-border px-6 py-2">
      {failed ? (
        <p className="text-xs text-muted-foreground">The recording can’t be played right now.</p>
      ) : (
        <audio
          controls
          autoPlay
          preload="none"
          aria-label="Call recording"
          className="h-9 w-full"
          src={conversationRecordingUrl(workspaceId, conversationId)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  )
}
