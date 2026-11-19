'use client'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatCount, formatRateOrCount, type ChannelRow } from '@/lib/audience-pulse-figures'
import { conversationChannelLabel } from '@/lib/history-source'
import { cn } from '@/lib/utils'

import { NO_ANSWER_FILL } from './answer-split-bar'

function AnsweredMeter({ row, overallAnsweredPercent }: { row: ChannelRow; overallAnsweredPercent: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn('relative h-1.5 w-28 rounded-full', row.flagged ? 'bg-orange-500/20' : 'bg-muted')}>
          <span
            className={cn('absolute inset-y-0 left-0 rounded-full', row.flagged ? NO_ANSWER_FILL : 'bg-muted-foreground/60')}
            style={{ width: `${row.answeredPercent}%` }}
          />
          <span
            className="absolute -inset-y-1 w-px bg-foreground/70"
            style={{ left: `${overallAnsweredPercent}%` }}
            aria-hidden
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {row.answeredPercent}% answered · all questions {overallAnsweredPercent}%
      </TooltipContent>
    </Tooltip>
  )
}

/** How each channel's questions were answered against the whole window. */
export function ChannelsSection({
  rows,
  overallAnsweredPercent,
}: {
  rows: readonly ChannelRow[]
  overallAnsweredPercent: number
}) {
  return (
    <section aria-labelledby="audience-pulse-channels" className="space-y-3">
      <h2 id="audience-pulse-channels" className="text-base font-semibold text-foreground">By channel</h2>
      <table className="w-full max-w-xl border-collapse text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th scope="col" className="py-2 pr-3 text-left font-normal"><span className="sr-only">Channel</span></th>
            <th scope="col" className="px-3 py-2 text-left font-normal">Answered · all {overallAnsweredPercent}%</th>
            <th scope="col" className="px-3 py-2 text-right font-normal"><span className="sr-only">Answered</span></th>
            <th scope="col" className="px-3 py-2 text-right font-normal">Questions</th>
            <th scope="col" className="py-2 pl-3 text-right font-normal">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.channel ?? 'none'} className="border-b border-border">
              <td className="py-2.5 pr-3 text-foreground">{conversationChannelLabel(row.channel)}</td>
              <td className="px-3 py-2.5">
                {row.aboveFloor ? <AnsweredMeter row={row} overallAnsweredPercent={overallAnsweredPercent} /> : null}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatRateOrCount(row.answeredCount, row.questionCount)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatCount(row.questionCount)}</td>
              <td className="py-2.5 pl-3 text-right tabular-nums text-muted-foreground">{row.sharePercent}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
