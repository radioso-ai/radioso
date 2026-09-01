import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import type { ErrorReportingService } from "../../../shared/errors/errorReportingService.js";
import { AppError } from "../../../shared/domain/errors.js";
import { markHttpResponseFailed } from "./httpResponseCompletion.js";

const isPayloadTooLargeError = (error: unknown): error is { status?: number; type?: string } =>
  Boolean(
    error &&
      typeof error === "object" &&
      (("status" in error && error.status === 413) || ("type" in error && error.type === "entity.too.large")),
  );

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

export const createErrorHandler = (errorReportingService?: ErrorReportingService) =>
  (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    markHttpResponseFailed(res);
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof AppError && error.code === "payload_too_large") {
      const requestPath = req.originalUrl || req.path;
      const isInlineDocumentMutation =
        requestPath.startsWith("/api/v1/document/") &&
        !requestPath.includes("/import") &&
        (req.method === "POST" || req.method === "PUT") &&
        req.is("application/json");
      res.status(413).json({
        error: {
          code: "payload_too_large",
          message: isInlineDocumentMutation
            ? "Document content exceeds the inline size limit. Import the file instead."
            : error.message,
        },
      });
      return;
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
      const requestPath = req.originalUrl || req.path;
      const isInlineDocumentMutation =
        requestPath.startsWith("/api/v1/document/") &&
        !requestPath.includes("/import") &&
        (req.method === "POST" || req.method === "PUT") &&
        req.is("application/json");
      res.status(413).json({
        error: {
          code: "payload_too_large",
          message: isInlineDocumentMutation
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

export const errorHandler = createErrorHandler();
