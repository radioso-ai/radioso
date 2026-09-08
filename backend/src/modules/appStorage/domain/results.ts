import { MAX_ERROR_MESSAGE_LENGTH, type AppError, type AppErrorCode } from "@radioso/app-contract";

/**
 * Every storage operation answers with a value or with one of the runtime
 * protocol's error codes. A failure carries no success type, so one is an answer
 * to any operation — which is what lets a shared classifier hand the same refusal
 * to a `get` and to an export.
 *
 * Throwing instead would make the gateway in front of this domain guess which
 * failures are an App's fault and which are the host's, and the protocol already
 * names that distinction.
 */
export interface AppStorageFailure {
  ok: false;
  error: AppError;
}

export type AppStorageResult<TValue> = { ok: true; value: TValue } | AppStorageFailure;

export const storageSuccess = <TValue>(value: TValue): AppStorageResult<TValue> => ({ ok: true, value });

/**
 * A message names declarations — a collection id, a field key, an index id — and
 * never a record key, a field key an App invented, or a stored value. Declarations
 * come from a manifest an operator approved; the rest is customer data, and an
 * error is the easiest way to carry it into a log.
 */
export const storageFailure = (code: AppErrorCode, message: string): AppStorageFailure => ({
  ok: false,
  error: { code, message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH) },
});

/**
 * SQLSTATE classes a caller can retry into: a connection that dropped, a server
 * out of a resource, an operator intervention, and the two concurrency failures
 * Postgres resolves by asking for the transaction again.
 */
const TRANSIENT_SQLSTATE_CLASSES = new Set(["08", "53", "57"]);
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01"]);
/** Socket-level failures reaching the database, which never carry a SQLSTATE. */
const TRANSIENT_SYSTEM_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

const errorCodeOf = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

const isTransient = (error: unknown): boolean => {
  const code = errorCodeOf(error);
  if (code === null) return false;
  return (
    TRANSIENT_SYSTEM_CODES.has(code) ||
    TRANSIENT_SQLSTATES.has(code) ||
    (code.length === 5 && TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2)))
  );
};

/**
 * Turns a failure the persistence layer raised into one of the two codes the
 * protocol has for "this is the host's problem". Nothing of the failure itself
 * reaches the message: a driver error carries the statement, and a statement
 * carries the record.
 */
export const classifyStorageFailure = (error: unknown): AppStorageFailure =>
  isTransient(error)
    ? storageFailure("unavailable", "Storage could not be reached for this call")
    : storageFailure("internal", "Storage failed for a reason it cannot attribute to this call");
