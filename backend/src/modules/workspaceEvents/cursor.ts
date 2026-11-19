import { createHash } from "node:crypto";

import { AppError } from "../../shared/domain/errors.js";
import { CursorPaginationError, decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";
import { WORKSPACE_EVENT_RETENTION_DAYS, type WorkspaceEventType } from "../../shared/domain/workspaceEvents.js";

/** A place in the log: the writing transaction's id and the row's position, both decimal text. */
export interface LogPosition {
  tx: string;
  position: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * How long a cursor stays usable: a day short of the retention window, so the events after any
 * cursor still accepted have not been removed. Every event after a cursor committed no earlier
 * than the longest transaction before its issue, far inside that day.
 */
const CURSOR_LIFETIME_MS = (WORKSPACE_EVENT_RETENTION_DAYS - 1) * DAY_MS;

const DECIMAL = /^\d{1,20}$/u;

/** The filter a cursor was issued for: the requested types, sorted, or `*` for every readable type. */
const filterKey = (requestedTypes: readonly WorkspaceEventType[] | null): string =>
  requestedTypes === null
    ? "*"
    : createHash("sha256").update([...new Set(requestedTypes)].sort().join(",")).digest("hex").slice(0, 16);

export const encodeLogCursor = (
  position: LogPosition,
  requestedTypes: readonly WorkspaceEventType[] | null,
  issuedAt: Date,
): string => encodeCursor({
  tx: position.tx,
  pos: position.position,
  filter: filterKey(requestedTypes),
  at: issuedAt.toISOString(),
});

/**
 * The position a cursor names. A cursor issued for another filter is refused, since paging a
 * different filter from it could pass events of the new types; one older than its lifetime is
 * refused as expired, since events after it may already be gone.
 */
export const decodeLogCursor = (
  cursor: string,
  requestedTypes: readonly WorkspaceEventType[] | null,
  now: Date,
): LogPosition => {
  let keys: Record<"tx" | "pos" | "filter" | "at", string>;
  try {
    keys = decodeCursorWithKeys(cursor, ["tx", "pos", "filter", "at"]).keys;
  } catch (error) {
    throw error instanceof CursorPaginationError ? new AppError(400, "invalid_cursor", "The cursor is not one this log issued") : error;
  }
  const issuedAt = new Date(keys.at);
  if (!DECIMAL.test(keys.tx) || !DECIMAL.test(keys.pos) || Number.isNaN(issuedAt.getTime())) {
    throw new AppError(400, "invalid_cursor", "The cursor is not one this log issued");
  }
  if (keys.filter !== filterKey(requestedTypes)) {
    throw new AppError(400, "cursor_filter_mismatch", "The cursor was issued for a different set of event types");
  }
  if (now.getTime() - issuedAt.getTime() > CURSOR_LIFETIME_MS) {
    throw new AppError(410, "cursor_expired", "The cursor is older than the log's retention window; start again without one");
  }
  return { tx: keys.tx, position: keys.pos };
};

/** The later of two positions in (transaction, position) order. */
export const laterPosition = (left: LogPosition, right: LogPosition): LogPosition => {
  const leftTx = BigInt(left.tx);
  const rightTx = BigInt(right.tx);
  if (leftTx !== rightTx) {
    return leftTx > rightTx ? left : right;
  }
  return BigInt(left.position) >= BigInt(right.position) ? left : right;
};
