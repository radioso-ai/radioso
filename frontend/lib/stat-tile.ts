/** One point of a stat tile's sparkline. */
export interface SparklinePoint {
  /** YYYY-MM-DD, the UTC day this point covers. */
  date: string
  /** The day's figure; null when it is undefined for the day, and the line bridges the gap. */
  value: number | null
}

/** Whether a change is an improvement; volume is neither. Never carried by colour alone. */
type StatDeltaTone = 'good' | 'bad' | 'neutral'

/** A stat tile's change against the previous window. */
export interface StatDelta {
  /** The whole line, e.g. "+6 pts vs previous 7 days". */
  text: string
  trend: 'up' | 'down' | 'flat'
  tone: StatDeltaTone
}
