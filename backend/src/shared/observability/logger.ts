import type { RequestHandler } from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import type { ProductAnalyticsEvent } from "../analytics/productAnalyticsTypes.js";
import type { IncidentEvent } from "../incidents/incidentTypes.js";
import type { CorrelationFields } from "./telemetry/correlation.js";

export const createLogger = (level = process.env.NODE_ENV === "production" ? "info" : "debug") =>
  pino({ level });

export type AppLogger = ReturnType<typeof createLogger>;

export interface RetrievalLogFields {
  rewriteStatus: string;
  rerankStatus: string;
  originalCandidateCount: number;
  rewrittenCandidateCount: number;
  lexicalCandidateCount: number;
  normalizedCandidateCount: number;
  finalContextCount: number;
  parsedSemanticQuery?: string;
  parsedLexicalQuery?: string;
  parsedConstraintCount: number;
  appliedConstraintCount: number;
  candidateFallbackApplied: boolean;
  fallbackApplied: boolean;
}

export const extractCorrelationLogFields = (correlation?: CorrelationFields): Record<string, string> | undefined => {
  if (!correlation) {
    return undefined;
  }

  const fields = Object.fromEntries(
    Object.entries(correlation).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );

  return Object.keys(fields).length > 0 ? fields : undefined;
};

export const extractIncidentLogFields = (
  incident?: Pick<IncidentEvent, "incidentType" | "severity" | "errorClass" | "correlation" | "requestContext">,
): Record<string, string> | undefined => {
  if (!incident) {
    return undefined;
  }

  const correlation = extractCorrelationLogFields(incident.correlation) ?? {};
  const fields = Object.fromEntries(
    Object.entries({
      incidentType: incident.incidentType,
      severity: incident.severity,
      errorClass: incident.errorClass,
      method: incident.requestContext?.method,
      route: incident.requestContext?.route,
      ...correlation,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );

  return Object.keys(fields).length > 0 ? fields : undefined;
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
      subjectId: analytics.subjectId,
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
  const parsedSemanticQuery =
    fields.parsedQuery &&
    typeof fields.parsedQuery === "object" &&
    "semanticQuery" in fields.parsedQuery &&
    typeof fields.parsedQuery.semanticQuery === "string"
      ? fields.parsedQuery.semanticQuery
      : undefined;
  const parsedLexicalQuery =
    fields.parsedQuery &&
    typeof fields.parsedQuery === "object" &&
    "lexicalQuery" in fields.parsedQuery &&
    typeof fields.parsedQuery.lexicalQuery === "string"
      ? fields.parsedQuery.lexicalQuery
      : undefined;
  const parsedConstraintCount =
    fields.parsedQuery &&
    typeof fields.parsedQuery === "object" &&
    "constraints" in fields.parsedQuery &&
    Array.isArray(fields.parsedQuery.constraints)
      ? fields.parsedQuery.constraints.length
      : 0;
  const appliedConstraintCount = Array.isArray(fields.appliedConstraints) ? fields.appliedConstraints.length : 0;

  return {
    rewriteStatus: fields.rewriteStatus,
    rerankStatus: fields.rerankStatus,
    originalCandidateCount: fields.originalCandidateCount,
    rewrittenCandidateCount: fields.rewrittenCandidateCount,
    lexicalCandidateCount,
    normalizedCandidateCount: fields.normalizedCandidateCount,
    finalContextCount: fields.finalContextCount,
    parsedSemanticQuery,
    parsedLexicalQuery,
    parsedConstraintCount,
    appliedConstraintCount,
    candidateFallbackApplied: fields.candidateFallbackApplied,
    fallbackApplied: fields.fallbackApplied,
  };
};

export const createHttpLogger = (logger: AppLogger): RequestHandler =>
  pinoHttp({
    logger,
    customProps: (req: { id?: string | number }) => ({
      requestId: req.id,
    }),
  }) as unknown as RequestHandler;
