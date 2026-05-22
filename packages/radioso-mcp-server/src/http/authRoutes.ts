import { ZodError, z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";

import { AuthServiceError, type AuthService } from "../auth/authService.js";
import type { AuditLogger } from "../audit/auditLogger.js";
import { CapabilityPolicyError } from "../policy/capabilityPolicy.js";
import { RadiosoApiError } from "../radiosoApiAdapter.js";
import { isRequestBodyTooLargeError, readJsonBody, writeJson } from "./nodeHttp.js";

const exchangeSchema = z.object({
  clientName: z.string().trim().min(1).optional(),
  radiosoApiToken: z.string().trim().min(1),
  requestedProfiles: z.array(z.string().trim().min(1)).optional(),
  requestedTools: z.array(z.string().trim().min(1)).optional(),
});

const BEARER_PREFIX = "Bearer ";

const readBearerToken = (req: IncomingMessage): string | null => {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const token = authorization.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
};

const writeError = (res: ServerResponse, statusCode: number, code: string, message: string, details?: unknown): void => {
  writeJson(res, statusCode, {
    error: {
      code,
      details,
      message,
    },
  });
};

const handleRouteError = (res: ServerResponse, error: unknown): void => {
  if (isRequestBodyTooLargeError(error)) {
    writeError(res, 413, error.code, "Request body is too large.", { maxBytes: error.maxBytes });
    return;
  }

  if (error instanceof ZodError) {
    writeError(res, 400, "invalid_arguments", "Request body failed validation.", error.flatten());
    return;
  }

  if (error instanceof AuthServiceError) {
    const statusCode = error.code === "invalid_access_token" ? 401 : 403;
    writeError(res, statusCode, error.code, error.message, error.details);
    return;
  }

  if (error instanceof CapabilityPolicyError) {
    writeError(res, 403, error.code, error.message, error.details);
    return;
  }

  if (error instanceof RadiosoApiError) {
    if (error.status === 401 || error.status === 403) {
      writeError(res, error.status, error.code ?? "authentication_failed", error.message, error.details);
      return;
    }

    if (error.status === 504) {
      writeError(res, 504, error.code ?? "upstream_timeout", error.message, error.details);
      return;
    }

    writeError(res, 502, error.code ?? "radioso_request_failed", error.message, error.details);
    return;
  }

  if (error instanceof Error) {
    writeError(res, 500, "internal_error", error.message);
    return;
  }

  writeError(res, 500, "internal_error", "Unexpected remote MCP server error.");
};

export interface AuthRouteDependencies {
  authService: AuthService;
  auditLogger?: AuditLogger;
}

const toAuditableRouteFailure = (
  error: unknown,
): {
  code: string;
  details?: unknown;
  message: string;
  outcome: "denied" | "error";
} => {
  if (error instanceof ZodError) {
    return {
      code: "invalid_arguments",
      details: error.flatten(),
      message: "Request body failed validation.",
      outcome: "denied",
    };
  }

  if (isRequestBodyTooLargeError(error)) {
    return {
      code: error.code,
      details: { maxBytes: error.maxBytes },
      message: "Request body is too large.",
      outcome: "denied",
    };
  }

  if (error instanceof AuthServiceError) {
    return {
      code: error.code,
      details: error.details,
      message: error.message,
      outcome: "denied",
    };
  }

  if (error instanceof CapabilityPolicyError) {
    return {
      code: error.code,
      details: error.details,
      message: error.message,
      outcome: "denied",
    };
  }

  if (error instanceof RadiosoApiError) {
    const authenticationFailure = error.status === 401 || error.status === 403;
    return {
      code: error.code ?? (authenticationFailure ? "authentication_failed" : "radioso_request_failed"),
      details: error.details,
      message: error.message,
      outcome: authenticationFailure ? "denied" : "error",
    };
  }

  if (error instanceof Error) {
    return {
      code: "internal_error",
      message: error.message,
      outcome: "error",
    };
  }

  return {
    code: "internal_error",
    message: "Unexpected remote MCP server error.",
    outcome: "error",
  };
};

const shouldAuditAtRoute = (error: unknown): boolean =>
  error instanceof ZodError || !(error instanceof AuthServiceError || error instanceof CapabilityPolicyError || error instanceof RadiosoApiError);

const toObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const emitRouteFailure = async (
  auditLogger: AuditLogger | undefined,
  eventType: string,
  error: unknown,
  metadata: Record<string, unknown> = {},
  sessionId?: string,
): Promise<void> => {
  if (!auditLogger) {
    return;
  }

  const failure = toAuditableRouteFailure(error);
  await auditLogger.emit({
    eventType,
    metadata: {
      ...metadata,
      code: failure.code,
      ...(failure.details !== undefined ? { details: failure.details } : {}),
      message: failure.message,
    },
    outcome: failure.outcome,
    sessionId,
  });
};

export const createAuthExchangeHandler = ({ authService, auditLogger }: AuthRouteDependencies) => {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown;

    try {
      body = await readJsonBody(req);
      const parsed = exchangeSchema.parse(body);
      const result = await authService.exchangeWorkspaceToken(parsed);
      writeJson(res, 200, result);
    } catch (error) {
      if (shouldAuditAtRoute(error)) {
        const requestBody = toObject(body);
        await emitRouteFailure(auditLogger, "auth.exchange_failed", error, {
          clientName: requestBody?.clientName,
          requestedProfiles: requestBody?.requestedProfiles,
          requestedTools: requestBody?.requestedTools,
        });
      }
      handleRouteError(res, error);
    }
  };
};

export { readBearerToken, writeError };
