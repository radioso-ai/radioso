import { ZodError } from "zod";

import { RadiosoApiError } from "./radiosoApiAdapter.js";

export interface StructuredToolError {
  code: string;
  details?: unknown;
  message: string;
}

export const toStructuredToolError = (error: unknown): StructuredToolError => {
  if (error instanceof ZodError) {
    return {
      code: "invalid_arguments",
      details: error.flatten(),
      message: "Tool arguments failed validation.",
    };
  }

  if (error instanceof RadiosoApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        code: "authentication_failed",
        details: error.details,
        message: error.message,
      };
    }

    if (error.status === 404) {
      return {
        code: error.code ?? "resource_not_found",
        details: error.details,
        message: error.message,
      };
    }

    return {
      code: error.code ?? "radioso_request_failed",
      details: error.details,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: "internal_error",
      message: error.message,
    };
  }

  return {
    code: "internal_error",
    message: "Unexpected MCP server error.",
  };
};
