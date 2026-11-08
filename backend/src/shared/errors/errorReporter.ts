import type { ErrorReportMessage, ErrorSeverity } from "./errorTypes.js";
import type { CorrelationFields } from "../observability/telemetry/correlation.js";

/**
 * Narrow port for code that only needs to *report* an error, not the full
 * {@link ErrorReportingService} surface. Background loops and process-level
 * crash handlers depend on this so they stay decoupled from how reporting is
 * assembled (sinks, redaction, correlation). {@link ErrorReportingService}
 * satisfies this structurally.
 *
 * A narrower port of its own must also declare `message?: ErrorReportMessage`, never
 * `string`. TypeScript checks a method-syntax parameter bivariantly, so a port that
 * declared `message?: string` would still accept the service, and its callers could pass
 * an error's raw message straight past the brand.
 */
export interface ErrorReporter {
  report(input: {
    errorType: string;
    error?: unknown;
    /**
     * A readable message built with `errorReportMessage` from safe values, such as a
     * classified provider failure's kind. The default names the report's type and the
     * error's class and code; the error's own message never reaches a sink, because a
     * provider can echo customer content back in it.
     */
    message?: ErrorReportMessage;
    severity?: ErrorSeverity;
    correlation?: CorrelationFields;
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
  }): Promise<unknown>;
}
