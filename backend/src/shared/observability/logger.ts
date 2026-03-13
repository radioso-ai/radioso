import type { RequestHandler } from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";

export const createLogger = (level = process.env.NODE_ENV === "production" ? "info" : "debug") =>
  pino({ level });

export type AppLogger = ReturnType<typeof createLogger>;

export interface RetrievalLogFields {
  rewriteStatus: string;
  rerankStatus: string;
  originalCandidateCount: number;
  rewrittenCandidateCount: number;
  normalizedCandidateCount: number;
  finalContextCount: number;
  candidateFallbackApplied: boolean;
  fallbackApplied: boolean;
}

export const extractRetrievalLogFields = (metadata?: Record<string, unknown>): RetrievalLogFields | undefined => {
  const retrieval = metadata?.retrieval;
  if (!retrieval || typeof retrieval !== "object") {
    return undefined;
  }

  const fields = retrieval as Partial<RetrievalLogFields>;
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

  return {
    rewriteStatus: fields.rewriteStatus,
    rerankStatus: fields.rerankStatus,
    originalCandidateCount: fields.originalCandidateCount,
    rewrittenCandidateCount: fields.rewrittenCandidateCount,
    normalizedCandidateCount: fields.normalizedCandidateCount,
    finalContextCount: fields.finalContextCount,
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
