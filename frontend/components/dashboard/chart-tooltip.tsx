'use client'

/**
 * Shared readout for recharts hover tooltips.
 *
 * Recharts' built-in tooltip paints a hard-coded white card and colours the
 * series text with the series colour, so on the dark theme it renders light text
 * on a light card. This component wears popover tokens instead, and follows the
 * tooltip hierarchy the charts use elsewhere: the value leads in primary ink, the
 * series name follows in muted ink, and identity is carried by a colour key beside
 * the row rather than by tinting the text.
 */
export type ChartTooltipRow = {
  key: string
  value: string
  label?: string
  color?: string
}

export function ChartTooltipCard({
  label,
  rows,
  total,
}: {
  label?: string
  rows: readonly ChartTooltipRow[]
  total?: { value: string; label: string }
}) {
  if (rows.length === 0) return null

  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md">
      {label ? <p className="text-xs text-muted-foreground">{label}</p> : null}
      <ul className={label ? 'mt-1.5 space-y-1' : 'space-y-1'}>
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2">
            {row.color ? (
              <span
                aria-hidden
                className="h-0.5 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: row.color }}
              />
            ) : null}
            <span className="text-sm font-medium tabular-nums">{row.value}</span>
            {row.label ? <span className="text-xs text-muted-foreground">{row.label}</span> : null}
          </li>
        ))}
      </ul>
      {total ? (
        <p className="mt-1.5 flex items-center gap-2 border-t pt-1.5">
          <span className="text-sm font-medium tabular-nums">{total.value}</span>
          <span className="text-xs text-muted-foreground">{total.label}</span>
        </p>
      ) : null}
    </div>
  )
}
