import type { StorageCollection } from "@radioso/app-contract";

const MILLISECONDS_PER_SECOND = 1000;

/**
 * When a record written now stops being readable. A ttl collection measures the
 * deadline from each write, so touching a record renews it; a collection that
 * retains everything writes no deadline at all.
 */
export const resolveExpiresAt = (collection: StorageCollection, now: Date): Date | null =>
  collection.retention.kind === "ttl"
    ? new Date(now.getTime() + collection.retention.seconds * MILLISECONDS_PER_SECOND)
    : null;

/**
 * A deadline that has been reached hides the record from every read, whether or
 * not the sweeper has removed the row yet. Reads must not depend on how recently
 * a sweep ran.
 */
export const isExpired = (expiresAt: Date | null, now: Date): boolean =>
  expiresAt !== null && expiresAt.getTime() <= now.getTime();
