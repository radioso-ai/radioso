import { extractExceptionDiagnostics } from "../domain/diagnostics.js";
import {
  AppStorageExportBusyError,
  AppStorageExportClosedError,
  AppStorageExportDeniedError,
  classifyStorageFailure,
  type AppStorageFailure,
} from "../domain/results.js";
import type { AppStorageDiagnosticsPort } from "../ports/appStorageDiagnostics.js";

/**
 * The identifiers a catch site already has in scope when an exception
 * reaches it. Every field is optional because not every operation resolves
 * every one of them before it can fail — a `query` refused on `invalid_input`
 * never reaches the repository at all, and has none of these to give.
 */
interface AppStorageFailureScope {
  workspaceId?: string;
  installationId?: string;
  collectionId?: string;
  indexId?: string;
}

/**
 * `classifyStorageFailure`'s three named branches — a denied, closed, or busy
 * export snapshot — are already fully explained by their own class; the
 * classification a caller receives says exactly what happened. What still
 * needs a cause written down is the generic branch: an exception nothing here
 * recognized, discarded into a sanitized `internal` or `unavailable` result.
 */
const isSelfExplaining = (error: unknown): boolean =>
  error instanceof AppStorageExportDeniedError ||
  error instanceof AppStorageExportClosedError ||
  error instanceof AppStorageExportBusyError;

/**
 * Classifies an exception the way every catch site in this module already
 * did, and — for the two codes that mean "the host's problem" rather than a
 * deterministic answer about the request — records its safe facts through
 * `diagnostics` before the exception itself is discarded.
 *
 * This is the one place that decision is made, so every service that
 * converts an exception takes the same port and gets the same answer for the
 * same failure, rather than six catch sites each deciding on their own.
 */
export const reportStorageFailure = (
  diagnostics: AppStorageDiagnosticsPort,
  operation: string,
  scope: AppStorageFailureScope,
  error: unknown,
): AppStorageFailure => {
  const result = classifyStorageFailure(error);

  if (!isSelfExplaining(error) && (result.error.code === "internal" || result.error.code === "unavailable")) {
    diagnostics.failure(
      {
        operation,
        ...scope,
        classification: result.error.code,
        ...extractExceptionDiagnostics(error),
      },
      `${operation} converted an exception to ${result.error.code}`,
    );
  }

  return result;
};
