import type { AppLogger } from "../observability/logger.js";
import { matchedRoutePattern } from "../observability/matchedRoute.js";
import { createRequestCorrelation, type CorrelationFields, type RequestCorrelationSource } from "../observability/telemetry/correlation.js";
import { redactRecord } from "../observability/telemetry/redactionPolicy.js";
import { errorRecordedLogFields } from "./errorRecordedLogFields.js";
import type { ErrorEvent, ErrorRequestContext, ErrorSeverity } from "./errorTypes.js";
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
  errorClass?: string;
  message?: string;
  stack?: string;
  correlation?: CorrelationFields;
  requestContext?: ErrorRequestContext;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}

const serializeError = (
  error: unknown,
): { errorClass?: string; message: string; stack?: string; metadata?: Record<string, unknown> } => {
  if (error instanceof Error) {
    return {
      errorClass: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (error && typeof error === "object") {
    return {
      errorClass: "NonErrorThrowable",
      message: "Non-error throwable",
      metadata: redactRecord(error as Record<string, unknown>),
    };
  }

  switch (typeof error) {
    // `typeof null === "object"`, but the object check above only returns for truthy objects,
    // so `null` is the only value that reaches this case.
    case "undefined":
    case "object":
      return { message: "Unknown error" };
    default:
      return { errorClass: typeof error, message: String(error) };
  }
};

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

    const serializedError = serializeError(input.error);
    const errorEvent: ErrorEvent = {
      errorType: input.errorType,
      timestamp: new Date().toISOString(),
      severity: input.severity ?? "error",
      service: this.options.service,
      environment: this.options.environment,
      version: this.options.version,
      message: input.message ?? serializedError.message,
      errorClass: input.errorClass ?? serializedError.errorClass,
      stack: input.stack ?? serializedError.stack,
      correlation: input.correlation,
      requestContext: input.requestContext,
      metadata: redactRecord({
        ...serializedError.metadata,
        ...input.metadata,
      }),
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

  async reportUnhandledRequestError(input: {
    error: unknown;
    request: RequestCorrelationSource;
    statusCode?: number;
  }): Promise<ErrorEvent | null> {
    // The matched pattern, never the URL: a path segment can hold a credential. An error raised
    // before any route matched carries no route at all.
    const route = matchedRoutePattern(input.request);
    return this.report({
      errorType: "http.request.unhandled",
      correlation: createRequestCorrelation(input.request),
      error: input.error,
      requestContext: {
        method: input.request.method,
        ...(route ? { route } : {}),
        statusCode: input.statusCode ?? 500,
      },
    });
  }
}
