import type { RequestHandler } from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import type { ProductAnalyticsEvent } from "../analytics/productAnalyticsTypes.js";
import type { ErrorEvent } from "../errors/errorTypes.js";
import { toCloudLoggingSeverity } from "./logging/cloudSeverity.js";
import { isClassName, isUuid } from "./logging/logSafeValues.js";
import { emitPinoLogRecordForOpenTelemetry } from "./logging/index.js";
import type { CorrelationFields } from "./telemetry/correlation.js";

const loggerOptions = (level: string): pino.LoggerOptions => ({
  level,
  formatters: {
    // Keep the numeric `level` so existing log queries keep working, and add the
    // `severity` string log platforms use to classify a line.
    level: (_label, numericLevel) => ({
      level: numericLevel,
      severity: toCloudLoggingSeverity(numericLevel),
    }),
  },
  hooks: {
    logMethod(args, method, pinoLevel) {
      emitPinoLogRecordForOpenTelemetry(pinoLevel, args);
      method.apply(this, args);
    },
  },
});

export const createLogger = (
  level = process.env.NODE_ENV === "production" ? "info" : "debug",
  destination?: pino.DestinationStream,
) => (destination ? pino(loggerOptions(level), destination) : pino(loggerOptions(level)));

export type AppLogger = ReturnType<typeof createLogger>;

interface RetrievalLogFields {
  rewriteStatus: string;
  rerankStatus: string;
  originalCandidateCount: number;
  rewrittenCandidateCount: number;
  lexicalCandidateCount: number;
  normalizedCandidateCount: number;
  finalContextCount: number;
  appliedConstraintCount: number;
  candidateFallbackApplied: boolean;
  fallbackApplied: boolean;
}

// A route reaches a log line as its path alone: the query string can carry search text a person typed.
// The error and correlation fields arrive as unknown metadata, so a non-string route is dropped, not dereferenced.
const routePath = (route: unknown): string | undefined =>
  typeof route === "string" ? route.replace(/[?#].*$/su, "") : undefined;

export const extractCorrelationLogFields = (correlation?: CorrelationFields): Record<string, string> | undefined => {
  if (!correlation) {
    return undefined;
  }

  const fields = Object.fromEntries(
    Object.entries({ ...correlation, route: routePath(correlation.route) })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );

  return Object.keys(fields).length > 0 ? fields : undefined;
};

export const extractErrorLogFields = (error?: unknown): Record<string, string> | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const fields = error as Partial<Pick<ErrorEvent, "errorType" | "severity" | "errorClass" | "correlation" | "requestContext">>;
  if (typeof fields.errorType !== "string" || typeof fields.severity !== "string") {
    return undefined;
  }

  const correlation = extractCorrelationLogFields(fields.correlation) ?? {};
  const logFields = Object.fromEntries(
    Object.entries({
      errorType: fields.errorType,
      severity: fields.severity,
      // A frontend report names its own error class, so only a class-name shape passes.
      errorClass: typeof fields.errorClass === "string" && isClassName(fields.errorClass) ? fields.errorClass : undefined,
      method: fields.requestContext?.method,
      route: routePath(fields.requestContext?.route),
      ...correlation,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );

  return Object.keys(logFields).length > 0 ? logFields : undefined;
};

export const extractProductAnalyticsLogFields = (
  analytics?: Pick<ProductAnalyticsEvent, "eventName" | "workspaceId" | "accountId" | "actorType" | "subjectType" | "subjectId" | "source">,
): Record<string, string> | undefined => {
  if (!analytics) {
    return undefined;
  }

  const fields = Object.fromEntries(
    Object.entries({
      eventName: analytics.eventName,
      workspaceId: analytics.workspaceId,
      accountId: analytics.accountId,
      actorType: analytics.actorType,
      subjectType: analytics.subjectType,
      // The frontend analytics route accepts any subject id string; only an id shape passes.
      subjectId: typeof analytics.subjectId === "string" && isUuid(analytics.subjectId) ? analytics.subjectId : undefined,
      source: analytics.source,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );

  return Object.keys(fields).length > 0 ? fields : undefined;
};

export const extractRetrievalLogFields = (metadata?: Record<string, unknown>): RetrievalLogFields | undefined => {
  const retrieval = metadata?.retrieval;
  if (!retrieval || typeof retrieval !== "object") {
    return undefined;
  }

  const fields = retrieval as Record<string, unknown> & Partial<RetrievalLogFields>;
  if (
    typeof fields.rewriteStatus !== "string" ||
    typeof fields.rerankStatus !== "string" ||
    typeof fields.originalCandidateCount !== "number" ||
    typeof fields.rewrittenCandidateCount !== "number" ||
    typeof fields.normalizedCandidateCount !== "number" ||
    typeof fields.finalContextCount !== "number" ||
    typeof fields.candidateFallbackApplied !== "boolean" ||
    typeof fields.fallbackApplied !== "boolean"
  ) {
    return undefined;
  }

  const lexicalCandidateCount =
    typeof fields.lexicalCandidateCount === "number" ? fields.lexicalCandidateCount : 0;
  const appliedConstraintCount = Array.isArray(fields.appliedConstraints) ? fields.appliedConstraints.length : 0;

  return {
    rewriteStatus: fields.rewriteStatus,
    rerankStatus: fields.rerankStatus,
    originalCandidateCount: fields.originalCandidateCount,
    rewrittenCandidateCount: fields.rewrittenCandidateCount,
    lexicalCandidateCount,
    normalizedCandidateCount: fields.normalizedCandidateCount,
    finalContextCount: fields.finalContextCount,
    appliedConstraintCount,
    candidateFallbackApplied: fields.candidateFallbackApplied,
    fallbackApplied: fields.fallbackApplied,
  };
};

// The request line names the request by method and path and the response by status. A query
// string or header can carry words a person typed, and the line lands in Cloud Logging, out of
// reach of conversation erasure. pino-http's own `requestId` and `responseTime` sit beside these.
const requestLogFields = (req: { id?: unknown; method?: unknown; url?: unknown }) => ({
  id: req.id,
  method: req.method,
  url: routePath(req.url),
});

const responseLogFields = (res: { statusCode?: unknown }) => ({ statusCode: res.statusCode });

export const createHttpLogger = (logger: AppLogger): RequestHandler =>
  pinoHttp({
    logger,
    serializers: {
      req: requestLogFields,
      res: responseLogFields,
    },
    customProps: (req: { id?: string | number }) => ({
      requestId: req.id,
    }),
  }) as unknown as RequestHandler;
