'use client'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatCount, percentOf, type AnswerSplitKey, type AnswerSplitPart } from '@/lib/audience-pulse-figures'
import { cn } from '@/lib/utils'

/** No answer in your content is the one figure the page asks the operator to act on, so it alone is warm. */
export const NO_ANSWER_FILL = 'bg-orange-500'

const SPLIT_FILL: Record<AnswerSplitKey, string> = {
  answered: 'bg-chart-1',
  noAnswer: NO_ANSWER_FILL,
  partly: 'bg-muted-foreground/60',
  outside: 'bg-muted-foreground/35',
  notAssessed: 'bg-muted-foreground/15',
}

function Swatch({ splitKey }: { splitKey: AnswerSplitKey }) {
  return <span className={cn('inline-block size-2.5 shrink-0 rounded-[2px]', SPLIT_FILL[splitKey])} aria-hidden />
}

const figure = (part: AnswerSplitPart, total: number) =>
  `${formatCount(part.count)} · ${percentOf(part.count, total)}%`

function SplitBar({ parts, total }: { parts: readonly AnswerSplitPart[]; total: number }) {
  return (
    <div
      role="img"
      aria-label={parts.map((part) => `${part.label} ${formatCount(part.count)}`).join(', ')}
      className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted"
    >
      {parts.filter((part) => part.count > 0).map((part) => (
        <Tooltip key={part.key}>
          <TooltipTrigger asChild>
            <span className={cn('h-full', SPLIT_FILL[part.key])} style={{ flex: `${part.count} 1 0` }} />
          </TooltipTrigger>
          <TooltipContent>{part.label} · {figure(part, total)}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/** The window's questions by how they were answered: one thin bar and its legend. */
export function AnswerSplitSummary({ parts, total }: { parts: readonly AnswerSplitPart[]; total: number }) {
  return (
    <div className="space-y-2">
      <SplitBar parts={parts} total={total} />
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-foreground">
        {parts.map((part) => (
          <li key={part.key} className="inline-flex items-center gap-1.5">
            <Swatch splitKey={part.key} />
            {part.label}
            <span className="tabular-nums text-muted-foreground">{figure(part, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One topic's questions by how they were answered: the bar over a figure list. */
export function AnswerSplitFigures({ parts, total }: { parts: readonly AnswerSplitPart[]; total: number }) {
  return (
    <div className="space-y-3">
      <SplitBar parts={parts} total={total} />
      <ul className="max-w-sm space-y-1 text-sm">
        {parts.map((part) => (
          <li key={part.key} className="grid grid-cols-[0.625rem_1fr_auto_3rem] items-center gap-x-3">
            <Swatch splitKey={part.key} />
            <span className="text-foreground">{part.label}</span>
            <span className="text-right tabular-nums text-foreground">{formatCount(part.count)}</span>
            <span className="text-right tabular-nums text-muted-foreground">{percentOf(part.count, total)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
