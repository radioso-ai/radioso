import { createHash } from "node:crypto";

import { AppError } from "../../shared/domain/errors.js";
import { CursorPaginationError, decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";
import {
  WORKSPACE_EVENT_RETENTION_DAYS,
  type LogPosition,
  type WorkspaceEventType,
} from "../../shared/domain/workspaceEventLog.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * How long a cursor stays usable: a day short of the retention window, counted from the place it
 * names, so the events after any cursor still accepted have not been removed.
 */
const CURSOR_LIFETIME_MS = (WORKSPACE_EVENT_RETENTION_DAYS - 1) * DAY_MS;

const DECIMAL = /^\d{1,20}$/u;
/** `xid8` is unsigned 64-bit and `position` a signed 64-bit identity: larger text fails in Postgres. */
const MAX_TX = 2n ** 64n - 1n;
const MAX_POSITION = 2n ** 63n - 1n;

const inRange = (value: string, max: bigint): boolean => DECIMAL.test(value) && BigInt(value) <= max;

const invalidCursor = (): AppError => new AppError(400, "invalid_cursor", "The cursor is not one this log issued");

/** The cursor was refused as older than its lifetime; the route counts it. */
export class CursorExpiredError extends AppError {
  constructor() {
    super(410, "cursor_expired", "The cursor is older than the log's retention window; start again without one");
    this.name = "CursorExpiredError";
  }
}

/** The filter a cursor was issued for: the requested types, sorted, or `*` for every readable type. */
const filterKey = (requestedTypes: readonly WorkspaceEventType[] | null): string =>
  requestedTypes === null
    ? "*"
    : createHash("sha256").update([...new Set(requestedTypes)].sort().join(",")).digest("hex").slice(0, 16);

/**
 * A cursor at `position`, for the filter it pages. `age` is the time its expiry counts from: when
 * the event it ends at happened, or the read that issued it for a cursor at the horizon.
 */
export const encodeLogCursor = (
  position: LogPosition,
  requestedTypes: readonly WorkspaceEventType[] | null,
  age: Date,
): string => encodeCursor({
  tx: position.tx,
  pos: position.position,
  filter: filterKey(requestedTypes),
  at: age.toISOString(),
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
    throw error instanceof CursorPaginationError ? invalidCursor() : error;
  }
  const age = new Date(keys.at);
  if (!inRange(keys.tx, MAX_TX) || !inRange(keys.pos, MAX_POSITION) || Number.isNaN(age.getTime())) {
    throw invalidCursor();
  }
  if (keys.filter !== filterKey(requestedTypes)) {
    throw new AppError(400, "cursor_filter_mismatch", "The cursor was issued for a different set of event types");
  }
  if (now.getTime() - age.getTime() > CURSOR_LIFETIME_MS) {
    throw new CursorExpiredError();
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
