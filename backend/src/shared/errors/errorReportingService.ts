import type { AppLogger } from "../observability/logger.js";
import { matchedRoutePattern } from "../observability/matchedRoute.js";
import { createRequestCorrelation, type CorrelationFields, type RequestCorrelationSource } from "../observability/telemetry/correlation.js";
import { redactRecord } from "../observability/telemetry/redactionPolicy.js";
import { errorRecordedLogFields } from "./errorRecordedLogFields.js";
import { defaultReportMessage, redactedErrorFields, reportFingerprint } from "./errorReportShape.js";
import type { ErrorEvent, ErrorReportMessage, ErrorRequestContext, ErrorSeverity } from "./errorTypes.js";
import type { ErrorSink } from "./errorSink.js";

interface ErrorReportingServiceOptions {
  enabled?: boolean;
  environment: string;
  logger: AppLogger;
  service: string;
  sinks?: ErrorSink[];
  version?: string;
}

interface ErrorInput {
  errorType: string;
  severity?: ErrorSeverity;
  error?: unknown;
  /** The class to name the report by, such as a browser error's; a value not shaped like a class name is dropped. */
  errorClass?: string;
  /** Built with `errorReportMessage`; the default names the report's type and the error's class and code. */
  message?: ErrorReportMessage;
  /** A stack held as text, such as a browser's; only its frames reach the report. */
  stack?: string;
  correlation?: CorrelationFields;
  requestContext?: ErrorRequestContext;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export class ErrorReportingService {
  // Identity-keyed, not content-keyed: two distinct errors with the same message must
  // never collide. Lets a caller that already reported an error (e.g. a chat turn
  // failure) tell a later handler on the same error object (e.g. the HTTP error
  // middleware, reached after headers were already sent) not to report it again.
  private readonly reportedErrors = new WeakSet<object>();

  constructor(private readonly options: ErrorReportingServiceOptions) {}

  /** Whether `report()` has already recorded this exact error object. */
  wasReported(error: unknown): boolean {
    return typeof error === "object" && error !== null && this.reportedErrors.has(error);
  }

  async report(input: ErrorInput): Promise<ErrorEvent | null> {
    if (this.options.enabled === false) {
      return null;
    }

    if (input.error && typeof input.error === "object") {
      this.reportedErrors.add(input.error);
    }

    // Every sink, the audit log included, gets the error's class, code, causes and frames, never
    // its message: that text can echo a provider response, document text, SQL or a visitor's words.
    const { identity, causes, stack } = redactedErrorFields(input);
    const errorEvent: ErrorEvent = {
      errorType: input.errorType,
      timestamp: new Date().toISOString(),
      severity: input.severity ?? "error",
      service: this.options.service,
      environment: this.options.environment,
      version: this.options.version,
      message: input.message ?? defaultReportMessage(input.errorType, identity, causes),
      ...identity,
      ...(causes.length > 0 ? { causes } : {}),
      ...(stack ? { stack } : {}),
      fingerprint: reportFingerprint(this.options.service, input.errorType, identity),
      correlation: input.correlation,
      requestContext: input.requestContext,
      metadata: redactRecord({ ...input.metadata }),
      tags: input.tags,
    };

    this.options.logger[errorEvent.severity](errorRecordedLogFields(errorEvent), "error_recorded");

    await Promise.all((this.options.sinks ?? []).map(async (sink) => {
      try {
        await sink.record(errorEvent);
      } catch (sinkError) {
        this.options.logger.error(
          {
            sinkName: sink.name,
            err: sinkError,
            errorType: errorEvent.errorType,
          },
          "error_sink_failed",
        );
      }
    }));

    return errorEvent;
  }

  async reportUnhandledRequestError(input: RequestFailure): Promise<ErrorEvent | null> {
    return this.reportRequestFailure({ ...input, errorType: "http.request.unhandled" });
  }

  /**
   * A failed request under the type its caller classified it as, such as a `databaseFailureReport`,
   * with the same correlation and request context as an unhandled one.
   */
  async reportRequestFailure(input: RequestFailure & {
    errorType: string;
    severity?: ErrorSeverity;
    message?: ErrorReportMessage;
    metadata?: Record<string, unknown>;
  }): Promise<ErrorEvent | null> {
    // The matched pattern, never the URL: a path segment can hold a credential. An error raised
    // before any route matched carries no route at all.
    const route = matchedRoutePattern(input.request);
    return this.report({
      errorType: input.errorType,
      severity: input.severity,
      message: input.message,
      correlation: createRequestCorrelation(input.request),
      error: input.error,
      requestContext: {
        method: input.request.method,
        ...(route ? { route } : {}),
        statusCode: input.statusCode ?? 500,
      },
      metadata: input.metadata,
    });
  }
}

interface RequestFailure {
  error: unknown;
  request: RequestCorrelationSource;
  statusCode?: number;
}
