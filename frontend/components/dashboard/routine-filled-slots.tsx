'use client'

import type { RoutineRunTraceView } from '@/lib/routine-run-trace'

/**
 * The slots a routine holds after the turn, marked new or replaced when this turn stored them.
 * A trace that carries the values (Test Chat) shows each beside its slot; any other shows the
 * slot names alone.
 */
export function RoutineFilledSlots({ trace }: { trace: RoutineRunTraceView }) {
  const capturedThisTurn = new Set(trace.capturedSlotKeys)
  const replacedThisTurn = new Set(trace.replacedSlotKeys ?? [])
  if (trace.filledSlotKeys.length === 0) {
    return <p className="text-sm text-muted-foreground">No slots filled yet.</p>
  }
  if (trace.slotValues) {
    const valueByKey = new Map(trace.slotValues.map((slot) => [slot.key, slot.value] as const))
    return (
      <div className="space-y-1.5">
        <dl className="space-y-1 rounded-md border border-border/60 bg-muted/20 p-2.5">
          {trace.filledSlotKeys.map((key) => (
            <div key={key} className="flex min-w-0 items-baseline gap-2 text-xs">
              <dt className="shrink-0 font-mono text-muted-foreground">
                {key}
                {capturedThisTurn.has(key) ? <span className="ml-1 text-emerald-600">• new</span> : null}
                {replacedThisTurn.has(key) ? <span className="ml-1 text-sky-600">• replaced</span> : null}
              </dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">{valueByKey.get(key) ?? ''}</dd>
            </div>
          ))}
        </dl>
        {trace.omittedSlotCount ? (
          <p className="text-[11px] text-muted-foreground">{trace.omittedSlotCount} more not shown</p>
        ) : null}
      </div>
    )
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {trace.filledSlotKeys.map((key) => (
        <li
          key={key}
          className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${
            capturedThisTurn.has(key)
              ? 'bg-emerald-500/10 text-emerald-600'
              : replacedThisTurn.has(key)
                ? 'bg-sky-500/10 text-sky-600'
                : 'bg-muted text-muted-foreground'
          }`}
        >
          {key}
          {capturedThisTurn.has(key) ? <span className="ml-1 not-italic">• new</span> : null}
          {replacedThisTurn.has(key) ? <span className="ml-1 not-italic">• replaced</span> : null}
        </li>
      ))}
    </ul>
  )
}
