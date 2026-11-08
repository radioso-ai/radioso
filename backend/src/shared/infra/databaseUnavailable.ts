import { pgErrorMeta } from "./kysely/sqlHelpers.js";

/**
 * Why a database call failed without the database answering it: the connection could not be
 * opened, borrowed, or kept. A bounded code for error reports and metrics, never a message.
 */
type DatabaseUnavailableReason =
  | "connect_timeout"
  | "pool_checkout_timeout"
  | "connection_lost"
  | "server_unavailable"
  | "connection_limit";

// The failures pg-pool 3 and pg 8 raise without a SQLSTATE, matched on the libraries' own fixed
// messages, whole.
const UNCODED_FAILURES: ReadonlyMap<string, DatabaseUnavailableReason> = new Map([
  // pg-pool: opening a new connection outlasted `connectionTimeoutMillis`.
  ["Connection terminated due to connection timeout", "connect_timeout"],
  // pg-pool: no pooled connection came free within `connectionTimeoutMillis`.
  ["timeout exceeded when trying to connect", "pool_checkout_timeout"],
  // pg: the server or the network closed the socket under an open connection.
  ["Connection terminated unexpectedly", "connection_lost"],
]);

// SQLSTATEs for a session the server refused or ended, rather than a statement it answered.
const SQLSTATE_REASONS: ReadonlyMap<string, DatabaseUnavailableReason> = new Map([
  ["57P01", "server_unavailable"], // admin_shutdown: a restart or maintenance ended the session
  ["57P02", "server_unavailable"], // crash_shutdown
  ["57P03", "server_unavailable"], // cannot_connect_now: the server is still starting
  ["53300", "connection_limit"], // too_many_connections
]);

// Class 08, connection_exception.
const CONNECTION_EXCEPTION_CLASS = "08";

// An error that stands for another (a 503 raised when a store fails) keeps it on `cause`.
const MAX_CAUSE_DEPTH = 4;

const reasonOf = (error: Error): DatabaseUnavailableReason | null => {
  const uncoded = UNCODED_FAILURES.get(error.message);
  if (uncoded) {
    return uncoded;
  }
  const { code } = pgErrorMeta(error);
  if (!code) {
    return null;
  }
  return SQLSTATE_REASONS.get(code) ?? (code.length === 5 && code.startsWith(CONNECTION_EXCEPTION_CLASS) ? "connection_lost" : null);
};

/**
 * The reason `error`, or an error it wraps, means the database could not be reached, or null when
 * the database answered: a constraint violation, a cancelled slow statement, and every failure
 * from outside the database stay null. A slow statement is the query's or the load's problem, not
 * the database's availability.
 */
export const classifyDatabaseUnavailable = (error: unknown): DatabaseUnavailableReason | null => {
  let current = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const reason = reasonOf(current);
    if (reason) {
      return reason;
    }
    current = current.cause;
  }
  return null;
};
