import { classifyDatabaseConnectionFailure, type DatabaseUnavailableReason } from "../infra/databaseConnectionFailure.js";
import { errorReportMessage, errorSummaryOf } from "./errorReportShape.js";
import type { ErrorReportMessage, ErrorSeverity } from "./errorTypes.js";

/** How a failure to get a database connection is reported, wherever it surfaces. */
interface DatabaseFailureReport {
  errorType: "database.unavailable" | "database.pool_exhausted";
  severity: ErrorSeverity;
  message: ErrorReportMessage;
  metadata?: { reason: DatabaseUnavailableReason };
}

/**
 * The report fields for a failure to get a database connection, or null for any other failure.
 * An unreachable database is `database.unavailable` at warning level with its `reason`: its own
 * type keeps an outage out of the groups code faults land in, and the fault is the database's
 * availability, not the code that called it. An exhausted pool is `database.pool_exhausted` at
 * error level: the database may be fine, and this process held every connection (a leak, a
 * connection kept across a slow call, slow queries filling the pool).
 */
export const databaseFailureReport = (error: unknown): DatabaseFailureReport | null => {
  const failure = classifyDatabaseConnectionFailure(error);
  if (!failure) {
    return null;
  }
  if (failure.kind === "pool_exhausted") {
    return {
      errorType: "database.pool_exhausted",
      severity: "error",
      message: errorReportMessage`Database pool exhausted: ${errorSummaryOf(error)}`,
    };
  }
  return {
    errorType: "database.unavailable",
    severity: "warn",
    message: errorReportMessage`Database unavailable (${failure.reason}): ${errorSummaryOf(error)}`,
    metadata: { reason: failure.reason },
  };
};
