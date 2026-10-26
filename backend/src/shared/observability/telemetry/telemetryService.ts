import type { RequestHandler } from "express";

import { extractCorrelationLogFields, type AppLogger } from "../logger.js";
import { shapeSafeFields } from "../logging/logSafeValues.js";
import { matchedRoutePattern } from "../matchedRoute.js";
import { createRequestCorrelation, type CorrelationFields, type RequestCorrelationSource } from "./correlation.js";
import { redactRecord } from "./redactionPolicy.js";
import type { TelemetryEvent, TelemetrySeverity, TelemetrySink } from "./telemetrySink.js";

interface TelemetryServiceOptions {
  enabled?: boolean;
  environment: string;
  logger: AppLogger;
  service: string;
  sinks?: TelemetrySink[];
  version?: string;
}

export interface TelemetryEventInput {
  eventType: string;
  severity?: TelemetrySeverity;
  correlation?: CorrelationFields;
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}

// Requests no route matched (404s, scanners, a 401 or 429 a middleware sent first) share one
// label: their raw paths could carry a token, and would give the route label unbounded values.
const UNMATCHED_ROUTE_LABEL = "unmatched";

// The telemetry_event line lands in Cloud Logging, which conversation erasure cannot reach. An
// emitter's metadata can carry an error message (a failed job's reason), so the line keeps only
// the entries whose shape rules out free text; the sinks still receive the event whole.
const telemetryLogMetadata = (metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  const safe = shapeSafeFields(metadata ?? {});
  return Object.keys(safe).length > 0 ? safe : undefined;
};

export class TelemetryService {
  constructor(private readonly options: TelemetryServiceOptions) {}

  async emit(input: TelemetryEventInput): Promise<TelemetryEvent | null> {
    if (this.options.enabled === false) {
      return null;
    }

    const event: TelemetryEvent = {
      eventType: input.eventType,
      timestamp: new Date().toISOString(),
      service: this.options.service,
      environment: this.options.environment,
      version: this.options.version,
      severity: input.severity ?? "info",
      correlation: input.correlation,
      metrics: input.metrics,
      metadata: redactRecord(input.metadata),
      tags: input.tags,
    };

    this.options.logger.info(
      {
        telemetry: {
          ...event,
          correlation: extractCorrelationLogFields(event.correlation),
          metadata: telemetryLogMetadata(event.metadata),
        },
      },
      "telemetry_event",
    );

    await Promise.all((this.options.sinks ?? []).map(async (sink) => {
      try {
        await sink.emit(event);
      } catch (error) {
        this.options.logger.error(
          {
            err: error,
            eventType: event.eventType,
          },
          "telemetry_sink_failed",
        );
      }
    }));

    return event;
  }
}

export const createRequestTelemetryMiddleware = (telemetryService: TelemetryService): RequestHandler =>
  ((req, res, next) => {
    const startedAt = Date.now();
    const request = req as RequestCorrelationSource;

    res.on("finish", () => {
      void telemetryService.emit({
        eventType: "http.request.completed",
        severity: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
        correlation: createRequestCorrelation(request),
        metrics: {
          durationMs: Date.now() - startedAt,
          statusCode: res.statusCode,
        },
        tags: {
          method: req.method,
          route: matchedRoutePattern(req) ?? UNMATCHED_ROUTE_LABEL,
        },
      });
    });

    next();
  }) as RequestHandler;
