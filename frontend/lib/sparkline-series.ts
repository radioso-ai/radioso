/** One point of a stat tile's sparkline. */
export interface SparklinePoint {
  /** YYYY-MM-DD, the UTC day this point covers. */
  date: string
  /** The day's figure; null when it is undefined for the day, and the line bridges the gap. */
  value: number | null
}
