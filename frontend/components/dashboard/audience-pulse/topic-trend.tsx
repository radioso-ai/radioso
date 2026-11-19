import type { AudiencePulseTheme } from '@/lib/api-audience-pulse'

const WIDTH = 76
const HEIGHT = 24
const PAD = 4

/**
 * A topic's weekly question count as a bare line, the latest week marked. Inline SVG rather than a
 * chart component: a table can hold dozens of these.
 */
export function TopicTrend({ title, weeks }: { title: string; weeks: AudiencePulseTheme['weeklyPulse'] }) {
  if (weeks.length < 2) return null
  const counts = weeks.map((week) => week.count)
  const min = Math.min(...counts)
  const max = Math.max(...counts)
  const span = max === min ? 1 : max - min
  const x = (index: number) => PAD + ((WIDTH - 2 * PAD) * index) / (counts.length - 1)
  const y = (count: number) => (max === min ? HEIGHT / 2 : PAD + (HEIGHT - 2 * PAD) * (1 - (count - min) / span))
  const last = counts.length - 1

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${title}, questions per week: ${counts.join(', ')}`}
      className="block"
    >
      <polyline
        points={counts.map((count, index) => `${x(index)},${y(count)}`).join(' ')}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(last)} cy={y(counts[last])} r={2.5} fill="var(--chart-1)" />
    </svg>
  )
}
