import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import { AppError } from "../../../shared/domain/errors.js";

const isPayloadTooLargeError = (error: unknown): error is { status?: number; type?: string } =>
  Boolean(
    error &&
      typeof error === "object" &&
      (("status" in error && error.status === 413) || ("type" in error && error.type === "entity.too.large")),
  );

export const errorHandler = (error: unknown, req: Request, res: Response, next: NextFunction): void => {
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

  console.error("Unhandled request error", {
    method: req.method,
    path: req.originalUrl || req.path,
    workspaceId: req.header("x-workspace-id"),
    error,
  });

  res.status(500).json({
    error: {
      code: "internal_error",
      message: "Internal server error",
    },
  });
};
