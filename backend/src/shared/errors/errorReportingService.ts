import { extractErrorLogFields, type AppLogger } from "../observability/logger.js";
import { createRequestCorrelation, type CorrelationFields, type RequestCorrelationSource } from "../observability/telemetry/correlation.js";
import { redactRecord } from "../observability/telemetry/redactionPolicy.js";
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

  return {
    errorClass: error === undefined || error === null ? undefined : typeof error,
    message: error === undefined || error === null ? "Unknown error" : String(error),
  };
};

export class ErrorReportingService {
  constructor(private readonly options: ErrorReportingServiceOptions) {}

  async report(input: ErrorInput): Promise<ErrorEvent | null> {
    if (this.options.enabled === false) {
      return null;
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

    this.options.logger.error(
      {
        error: extractErrorLogFields(errorEvent),
        metadata: errorEvent.metadata,
        stack: errorEvent.stack,
      },
      "error_recorded",
    );

    await Promise.all((this.options.sinks ?? []).map(async (sink) => {
      try {
        await sink.record(errorEvent);
      } catch (sinkError) {
        this.options.logger.error(
          {
            err: sinkError instanceof Error ? sinkError.message : String(sinkError),
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
    return this.report({
      errorType: "http.request.unhandled",
      correlation: createRequestCorrelation(input.request),
      error: input.error,
      requestContext: {
        method: input.request.method,
        route: input.request.originalUrl || input.request.path,
        statusCode: input.statusCode ?? 500,
      },
    });
  }
}
