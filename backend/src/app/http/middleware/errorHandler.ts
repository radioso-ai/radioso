import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import type { ErrorReportingService } from "../../../shared/errors/errorReportingService.js";
import { AppError } from "../../../shared/domain/errors.js";
import { applyRetryAfterFromError } from "../rateLimitHeaders.js";
import { markHttpResponseFailed } from "./httpResponseCompletion.js";

const isPayloadTooLargeError = (error: unknown): error is { status?: number; type?: string } =>
  Boolean(
    error &&
      typeof error === "object" &&
      (("status" in error && error.status === 413) || ("type" in error && error.type === "entity.too.large")),
  );

/**
 * A write to the document collection or one document's own body — `POST /api/v1/document` or
 * `PUT /api/v1/document/{documentId}` — as opposed to a sub-resource such as `/import`. Matches
 * the bare path itself, not just paths with something after a trailing slash, so a client that
 * calls the collection route without a trailing slash (every first-party caller does) is still
 * recognized.
 */
const isInlineDocumentMutationRequest = (req: Request): boolean => {
  const requestPath = req.originalUrl || req.path;
  const isDocumentCollectionPath = requestPath === "/api/v1/document" || requestPath.startsWith("/api/v1/document/");
  return Boolean(
    isDocumentCollectionPath &&
    !requestPath.includes("/import") &&
    (req.method === "POST" || req.method === "PUT") &&
    req.is("application/json"),
  );
};

const isStructuredAppError = (error: unknown): error is {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
} =>
  Boolean(
    error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      "code" in error &&
      typeof error.code === "string" &&
      "message" in error &&
      typeof error.message === "string",
  );

/** Ends an already-started response (SSE, chunked) if it has not finished on its own. */
const endOpenResponse = (res: Response): void => {
  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
};

export const createErrorHandler = (errorReportingService?: ErrorReportingService) =>
  (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    markHttpResponseFailed(res);
    if (res.headersSent) {
      // Headers already went out (an SSE turn mid-stream, most often), so there is no
      // response left to shape — only whether this fault reaches error tracking. Express's
      // own finalhandler would otherwise just console.error the raw stack with nothing
      // reaching PostHog; an AppError is an already-handled, expected outcome (quota,
      // validation, cancellation, disconnect) and never reported; anything else is
      // reported once, skipped here if the caller already reported this exact error object
      // (e.g. ChatTurnLifecycle.recordFailure, upstream in the same request).
      if (!(error instanceof AppError) && !errorReportingService?.wasReported(error)) {
        void errorReportingService?.reportUnhandledRequestError({ error, request: req });
      }
      endOpenResponse(res);
      return;
    }

    if (error instanceof AppError && error.code === "payload_too_large") {
      res.status(413).json({
        error: {
          code: "payload_too_large",
          message: isInlineDocumentMutationRequest(req)
            ? "Document content exceeds the inline size limit. Import the file instead."
            : error.message,
        },
      });
      return;
    }

    // Both branches below answer a 429, whoever raised it, so the retry hint is set once here
    // rather than at every limiter.
    if (isStructuredAppError(error)) {
      applyRetryAfterFromError(res, error);
    }

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
      return;
    }

    if (isStructuredAppError(error)) {
      res.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
      return;
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: {
          code: "payload_too_large",
          message: "Uploaded file exceeds maximum size",
        },
      });
      return;
    }

    if (isPayloadTooLargeError(error)) {
      res.status(413).json({
        error: {
          code: "payload_too_large",
          message: isInlineDocumentMutationRequest(req)
            ? "Document content exceeds the inline size limit. Import the file instead."
            : "Request body exceeds maximum size",
        },
      });
      return;
    }

    void errorReportingService?.reportUnhandledRequestError({
      error,
      request: req,
      statusCode: 500,
    });

    res.status(500).json({
      error: {
        code: "internal_error",
        message: "Internal server error",
      },
    });
  };
