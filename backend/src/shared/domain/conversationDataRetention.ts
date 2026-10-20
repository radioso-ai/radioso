/**
 * A fixed retention window over conversation-derived rows one module owns, enforced while their
 * conversation lives on: a summary past its expiry, a routine state nobody came back to, the raw copy
 * of an email. The module that owns the rows implements the rule; application composition hands every
 * rule to the retention sweep, which runs them in bounded batches. A conversation that a workspace's
 * own window passed is not a rule's to remove: it goes through the conversation erasure, which takes
 * every copy with it.
 */
export interface ConversationDataRetentionRule {
  /** What the sweep reports the rule's count under: its table, or `table.column` for a cleared copy. */
  readonly table: string;
  /**
   * Removes, or clears, at most `limit` rows the window passed at `now`, and returns how many. Rows
   * another transaction holds are skipped rather than waited for, so two sweeps at once remove each
   * row once and a sweep run again finds only what is left.
   */
  enforce(input: { now: Date; limit: number }): Promise<number>;
}
