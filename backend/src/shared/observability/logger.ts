import type { RequestHandler } from "express";
import { EDGE_FACTS_HEADERS } from "@radioso/edge-proof";
import pino from "pino";
import { pinoHttp } from "pino-http";
import type { ProductAnalyticsEvent } from "../analytics/productAnalyticsTypes.js";
import type { ErrorEvent } from "../errors/errorTypes.js";
import { toCloudLoggingSeverity } from "./logging/cloudSeverity.js";
import { isClassName, isUuid } from "./logging/logSafeValues.js";
import { emitPinoLogRecordForOpenTelemetry } from "./logging/index.js";
import type { CorrelationFields } from "./telemetry/correlation.js";
import { redactedValue, shouldRedactKey } from "./telemetry/redactionPolicy.js";
import { WORKER_TASK_AUTH_HEADER_LOWERCASE } from "../infra/workerTaskAuth.js";

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

const httpCredentialHeaderNames = ["cookie", "authorization", "x-radioso-public-session", "set-cookie"].filter(shouldRedactKey);
const httpRequestCredentialHeaderNames = httpCredentialHeaderNames.filter((headerName) => headerName !== "set-cookie");
const httpResponseCredentialHeaderNames = httpCredentialHeaderNames.filter((headerName) => headerName === "set-cookie");
const httpRequestClientAddressHeaderNames = [
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "fastly-client-ip",
  "x-envoy-external-address",
];
const httpHeaderRedactPath = (target: "req" | "res", headerName: string): string =>
  `${target}.headers["${headerName}"]`;

const httpLoggerRedactPaths = [
  ...httpRequestCredentialHeaderNames.map((headerName) => httpHeaderRedactPath("req", headerName)),
  ...httpRequestClientAddressHeaderNames.map((headerName) => httpHeaderRedactPath("req", headerName)),
  httpHeaderRedactPath("req", WORKER_TASK_AUTH_HEADER_LOWERCASE),
  httpHeaderRedactPath("req", "x-workspace-id"),
  // The frontend's signed edge facts carry the visitor's forwarded-for chain,
  // user agent, and geo headers, and ride on every relayed request.
  httpHeaderRedactPath("req", EDGE_FACTS_HEADERS.facts),
  httpHeaderRedactPath("req", EDGE_FACTS_HEADERS.signature),
  ...httpResponseCredentialHeaderNames.map((headerName) => httpHeaderRedactPath("res", headerName)),
  // Anonymous-session id response headers set in app/http/middleware/resolveAnonymousSession.ts.
  // They carry the same raw session id as set-cookie but are not classified as sensitive by
  // shouldRedactKey, so they must be redacted explicitly here (mirrors the set-cookie/session-id leak).
  httpHeaderRedactPath("res", "x-radioso-anonymous-session"),
  httpHeaderRedactPath("res", "x-radioso-public-session-id"),
];

export const createHttpLogger = (logger: AppLogger): RequestHandler =>
  pinoHttp({
    logger,
    redact: {
      paths: httpLoggerRedactPaths,
      censor: redactedValue(),
    },
    customProps: (req: { id?: string | number }) => ({
      requestId: req.id,
    }),
  }) as unknown as RequestHandler;
