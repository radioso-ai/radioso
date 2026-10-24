/**
 * A fixed retention window enforced on its own schedule, independent of any workspace's own
 * conversation window: a summary past its expiry, a routine state nobody came back to, the raw copy
 * of an email, an audit event past its own age window. The owning module implements the rule;
 * application composition hands every rule to the retention sweep, which runs them in bounded
 * batches. A conversation that a workspace's own window passed is not a rule's to remove: it goes
 * through the conversation erasure, which takes every copy with it.
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
  /**
   * Runs once after this rule's batches for a run end, with the total `enforce` removed across them.
   * Optional: most rules need nothing beyond the sweep's own row count, so most do not implement it.
   * A rule that keeps its own record of being enforced — the audit event sweep writes one summary
   * event per run — implements it instead of writing on every batch. The deletion this reports has
   * already committed, so a rule must treat a failure here as its own: the sweep logs it without
   * retrying the deletion or counting the run as failed.
   */
  onRunComplete?(input: { now: Date; totalRemoved: number }): Promise<void>;
}
