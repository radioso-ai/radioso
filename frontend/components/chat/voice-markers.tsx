'use client'

import { Clock, Mic, Volume2, VolumeX } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { OperatorReplySpeech, ReplyInterruption } from '@/lib/api-types'
import type { WebsiteEmbedTheme } from '@/lib/embed-widget'
import { heardPercent } from '@/lib/reply-interruption'

export function SpokenMarker({ label, theme }: { label: string; theme?: WebsiteEmbedTheme | null }) {
  return (
    <span
      className="inline-flex w-fit items-center gap-1 px-1 text-xs text-muted-foreground"
      style={theme ? { color: theme.mutedForeground } : undefined}
    >
      <Mic aria-hidden="true" className="size-3" />
      {label}
    </span>
  )
}

export function InterruptedReplyBadge({ interruption }: { interruption: ReplyInterruption }) {
  const percent = heardPercent(interruption.heardCharacterCount, interruption.spokenCharacterCount)
  // A reply cut off mid-stream is stored as far as it was heard, so there is no share to state.
  const tooltip = interruption.partial
    ? 'Cut off while speaking. Only what was heard is stored.'
    : `The caller spoke over this reply.${percent === undefined ? '' : ` About ${percent}% was heard.`}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} className="w-fit cursor-default gap-1 px-2 py-0 text-[11px] font-medium">
          <VolumeX aria-hidden="true" className="size-3" />
          Interrupted
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

const OPERATOR_REPLY_SPEECH_BADGES = {
  pending: { Icon: Clock, label: 'Pending', tooltip: 'The caller hears this on their next turn.' },
  spoken: { Icon: Volume2, label: 'Spoken', tooltip: 'Spoken to the caller on the call.' },
  skipped: { Icon: VolumeX, label: 'Not spoken: no words to say', tooltip: 'A call speaks words only, and this reply has none.' },
} as const satisfies Record<OperatorReplySpeech['state'], { Icon: typeof Clock; label: string; tooltip: string }>

export function OperatorReplySpeechBadge({ speech }: { speech: OperatorReplySpeech }) {
  const { Icon, label, tooltip } = OPERATOR_REPLY_SPEECH_BADGES[speech.state]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} className="w-fit cursor-default gap-1 px-2 py-0 text-[11px] font-medium">
          <Icon aria-hidden="true" className="size-3" />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
