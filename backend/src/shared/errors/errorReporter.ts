import type { ErrorSeverity } from "./errorTypes.js";
import type { CorrelationFields } from "../observability/telemetry/correlation.js";

/**
 * Narrow port for code that only needs to *report* an error, not the full
 * {@link ErrorReportingService} surface. Background loops and process-level
 * crash handlers depend on this so they stay decoupled from how reporting is
 * assembled (sinks, redaction, correlation). {@link ErrorReportingService}
 * satisfies this structurally.
 */
export interface ErrorReporter {
  report(input: {
    errorType: string;
    error?: unknown;
    severity?: ErrorSeverity;
    correlation?: CorrelationFields;
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
  }): Promise<unknown>;
}
