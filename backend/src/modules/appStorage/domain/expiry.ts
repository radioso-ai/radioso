import type { StorageCollection } from "@radioso/app-contract";

/**
 * How long a record written now stays readable, or `null` when the collection
 * retains everything. The deadline itself is never computed here: a write can
 * wait on a lock for an unbounded time, so the only timestamp that produces the
 * right answer is the one the database reads when the row actually lands. What
 * the domain owns is the interval; the repository turns it into a deadline in
 * SQL, from the writing transaction's own clock.
 *
 * A ttl collection measures the interval from each write, so touching a record
 * renews it.
 */
export const resolveTtlSeconds = (collection: StorageCollection): number | null =>
  collection.retention.kind === "ttl" ? collection.retention.seconds : null;
