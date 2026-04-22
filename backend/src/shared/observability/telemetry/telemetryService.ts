import type { RequestHandler } from "express";

import { extractCorrelationLogFields, type AppLogger } from "../logger.js";
import { createRequestCorrelation, type CorrelationFields, type RequestCorrelationSource } from "./correlation.js";
import { redactRecord } from "./redactionPolicy.js";
import type { TelemetryEvent, TelemetrySeverity, TelemetrySink } from "./telemetrySink.js";

export interface TelemetryServiceOptions {
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

interface RequestRouteSource extends RequestCorrelationSource {
  baseUrl?: string;
  route?: {
    path?: string | string[];
  };
}

const normalizeRouteSegment = (segment: string): string => {
  if (/^\d+$/.test(segment)) {
    return ":id";
  }

  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) {
    return ":id";
  }

  if (segment.length > 24 && /^[a-zA-Z0-9_-]+$/.test(segment)) {
    return ":id";
  }

  return segment;
};

const normalizeRouteLabel = (path: string): string => {
  const [pathname] = path.split("?");
  return pathname
    .split("/")
    .map((segment) => normalizeRouteSegment(segment))
    .join("/") || "/";
};

const buildRouteLabel = (request: RequestRouteSource): string => {
  if (typeof request.route?.path === "string") {
    const baseUrl = request.baseUrl ?? "";
    return `${baseUrl}${request.route.path}` || "/";
  }

  if (Array.isArray(request.route?.path) && typeof request.route.path[0] === "string") {
    const baseUrl = request.baseUrl ?? "";
    return `${baseUrl}${request.route.path[0]}` || "/";
  }

  return normalizeRouteLabel(request.originalUrl || request.path || "/");
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
            err: error instanceof Error ? error.message : String(error),
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
    const request = req as RequestRouteSource;

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
          route: buildRouteLabel(request),
        },
      });
    });

    next();
  }) as RequestHandler;
