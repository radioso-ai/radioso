import { extractIncidentLogFields, type AppLogger } from "../observability/logger.js";
import { createRequestCorrelation, type CorrelationFields, type RequestCorrelationSource } from "../observability/telemetry/correlation.js";
import { redactRecord } from "../observability/telemetry/redactionPolicy.js";
import type { IncidentEvent, IncidentRequestContext, IncidentSeverity } from "./incidentTypes.js";
import type { IncidentSink } from "./incidentSink.js";

interface IncidentReportingServiceOptions {
  enabled?: boolean;
  environment: string;
  logger: AppLogger;
  service: string;
  sinks?: IncidentSink[];
  version?: string;
}

interface IncidentInput {
  incidentType: string;
  severity?: IncidentSeverity;
  error?: unknown;
  message?: string;
  correlation?: CorrelationFields;
  requestContext?: IncidentRequestContext;
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

export class IncidentReportingService {
  constructor(private readonly options: IncidentReportingServiceOptions) {}

  async report(input: IncidentInput): Promise<IncidentEvent | null> {
    if (this.options.enabled === false) {
      return null;
    }

    const serializedError = serializeError(input.error);
    const incident: IncidentEvent = {
      incidentType: input.incidentType,
      timestamp: new Date().toISOString(),
      severity: input.severity ?? "error",
      service: this.options.service,
      environment: this.options.environment,
      version: this.options.version,
      message: input.message ?? serializedError.message,
      errorClass: serializedError.errorClass,
      stack: serializedError.stack,
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
        incident: extractIncidentLogFields(incident),
        metadata: incident.metadata,
        stack: incident.stack,
      },
      "incident_recorded",
    );

    await Promise.all((this.options.sinks ?? []).map(async (sink) => {
      try {
        await sink.record(incident);
      } catch (error) {
        this.options.logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
            incidentType: incident.incidentType,
          },
          "incident_sink_failed",
        );
      }
    }));

    return incident;
  }

  async reportUnhandledRequestError(input: {
    error: unknown;
    request: RequestCorrelationSource;
    statusCode?: number;
  }): Promise<IncidentEvent | null> {
    return this.report({
      incidentType: "http.request.unhandled",
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
