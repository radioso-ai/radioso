import { DatabaseError } from "pg";

import { pgErrorMeta } from "./kysely/sqlHelpers.js";

/**
 * Why a database call failed without the database answering it: a connection could not be opened
 * or kept. A bounded code for error reports and metrics, never a message.
 */
export type DatabaseUnavailableReason =
  | "connect_timeout"
  | "connect_failed"
  | "connection_lost"
  | "server_unavailable"
  | "connection_limit";

/**
 * What a failed call says about its database connection. `unavailable` is the database's own
 * availability. `pool_exhausted` is this process holding every pooled connection: the database
 * may be fine, and the cause is a leak, a connection kept across a slow call, or slow queries
 * filling the pool.
 */
type DatabaseConnectionFailure =
  | { kind: "unavailable"; reason: DatabaseUnavailableReason }
  | { kind: "pool_exhausted" };

// pg-pool 3: no pooled connection came free within `connectionTimeoutMillis`. Matched on the
// library's own fixed message, whole.
const POOL_CHECKOUT_TIMEOUT = "timeout exceeded when trying to connect";

// The failures pg-pool 3 and pg 8 raise without a SQLSTATE, matched on the libraries' own fixed
// messages, whole.
const UNCODED_FAILURES: ReadonlyMap<string, DatabaseUnavailableReason> = new Map([
  // pg-pool: opening a new connection outlasted `connectionTimeoutMillis`.
  ["Connection terminated due to connection timeout", "connect_timeout"],
  // pg: the server or the network closed the socket under an open connection.
  ["Connection terminated unexpectedly", "connection_lost"],
]);

// SQLSTATEs for a session the server refused or ended, rather than a statement it answered.
// 08P01 (protocol_violation) is left out on purpose: it is a message this process got wrong, such
// as a statement over the bind-parameter limit.
const SQLSTATE_REASONS: ReadonlyMap<string, DatabaseUnavailableReason> = new Map([
  ["08000", "connection_lost"], // connection_exception
  ["08003", "connection_lost"], // connection_does_not_exist
  ["08006", "connection_lost"], // connection_failure
  ["08007", "connection_lost"], // transaction_resolution_unknown: the connection went during COMMIT
  ["08001", "connect_failed"], // sqlclient_unable_to_establish_sqlconnection
  ["08004", "connect_failed"], // sqlserver_rejected_establishment_of_sqlconnection
  ["57P01", "server_unavailable"], // admin_shutdown: a restart or maintenance ended the session
  ["57P02", "server_unavailable"], // crash_shutdown
  ["57P03", "server_unavailable"], // cannot_connect_now: the server is still starting
  ["53300", "connection_limit"], // too_many_connections
]);

// Errors `Database`'s pool raised while opening or borrowing a connection, before any statement.
const connectFailures = new WeakSet<object>();

/** Marks `error` as raised while getting a pooled connection. Returns it unchanged. */
export const markConnectFailure = <T>(error: T): T => {
  if (typeof error === "object" && error !== null) {
    connectFailures.add(error);
  }
  return error;
};

// An error that stands for another (a 503 raised when a store fails) keeps it on `cause`.
const MAX_CAUSE_DEPTH = 4;

const failureOf = (error: Error): DatabaseConnectionFailure | null => {
  if (error.message === POOL_CHECKOUT_TIMEOUT) {
    return { kind: "pool_exhausted" };
  }
  const reason = UNCODED_FAILURES.get(error.message) ?? SQLSTATE_REASONS.get(pgErrorMeta(error).code ?? "");
  if (reason) {
    return { kind: "unavailable", reason };
  }
  // Getting a connection failed before the server said anything: refused, unresolvable, reset. A
  // server that answered (wrong credentials, a missing database) sent a DatabaseError, which stays
  // a fault for whoever configured it.
  if (connectFailures.has(error) && !(error instanceof DatabaseError)) {
    return { kind: "unavailable", reason: "connect_failed" };
  }
  return null;
};

/**
 * What `error`, or an error it wraps, says about the database connection, or null when the
 * database answered: a constraint violation, a cancelled slow statement, a protocol violation,
 * refused credentials, and every failure from outside the database stay null. A socket reset in
 * the middle of a statement also stays null; only connection loss pg reports as such is named.
 */
export const classifyDatabaseConnectionFailure = (error: unknown): DatabaseConnectionFailure | null => {
  let current = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const failure = failureOf(current);
    if (failure) {
      return failure;
    }
    current = current.cause;
  }
  return null;
};
