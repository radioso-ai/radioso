import type { AppStorageExceptionDiagnostics } from "../domain/diagnostics.js";

/**
 * The two codes {@link classifyStorageFailure} hands out for "this is the
 * host's problem" rather than the caller's. Every other code a storage
 * operation returns is a deterministic answer about the request — a missing
 * record, a quota, a version conflict — and none of those need a cause
 * written down; only these two do.
 */
type AppStorageDiagnosticClassification = "internal" | "unavailable";

/**
 * What one exception-to-result conversion records: the operation it happened
 * in, whichever identifiers were already known at that point, how it was
 * classified, and the exception's own safe facts. Never a record key, a
 * stored value, a query parameter, or a driver's own prose about the failure
 * — {@link extractExceptionDiagnostics} is what keeps those out.
 */
export interface AppStorageDiagnosticFields {
  operation: string;
  workspaceId?: string;
  installationId?: string;
  collectionId?: string;
  indexId?: string;
  classification: AppStorageDiagnosticClassification;
  exceptionClass: AppStorageExceptionDiagnostics["exceptionClass"];
  sqlState: AppStorageExceptionDiagnostics["sqlState"];
  constraint: AppStorageExceptionDiagnostics["constraint"];
  stack: AppStorageExceptionDiagnostics["stack"];
}

/**
 * Where a storage exception's cause is written down before it is discarded
 * into a sanitized `internal` or `unavailable` result. Every service that
 * converts an exception into one of those two codes takes this as a required
 * dependency: a missing migration, a schema drift, or a persistent database
 * fault must leave a trail an operator can act on, not just a result the
 * caller retries.
 */
export interface AppStorageDiagnosticsPort {
  failure(fields: AppStorageDiagnosticFields, message: string): void;
}
