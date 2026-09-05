import { randomUUID } from "node:crypto";
import {
  OperatorAdmissionRequestSchema,
  OperatorAdmissionResponseSchema,
  OperatorCatalogRequestSchema,
  OperatorCatalogResponseSchema,
  OperatorInvocationRequestSchema,
  OperatorInvocationResponseSchema,
  OPERATOR_MCP_EXECUTION_TIMEOUT_MS,
  OPERATOR_SERVICE_AUTH_HEADERS,
  createOperatorMcpRequestSignature,
  sha256Digest,
  type OperatorAdmissionRequest,
  type OperatorAdmissionResponse,
  type OperatorCatalogResponse,
  type OperatorInvocationRequest,
  type OperatorInvocationResponse,
  type OperatorMcpProof,
} from "@radioso/operator-mcp-contract";

const OPERATOR_BACKEND_TRANSPORT_OVERHEAD_MS = 5_000;

export const operatorBackendRequestTimeoutMs = (configuredTimeoutMs: number): number =>
  Math.max(configuredTimeoutMs, OPERATOR_MCP_EXECUTION_TIMEOUT_MS + OPERATOR_BACKEND_TRANSPORT_OVERHEAD_MS);

export class OperatorBackendAdapterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: OperatorBackendAdapterErrorCode,
    readonly requiredScope?: string,
  ) {
    super(message);
    this.name = "OperatorBackendAdapterError";
  }
}

export type OperatorBackendAdapterErrorCode =
  | "unauthorized"
  | "insufficient_scope"
  | "unavailable"
  | "invalid_response"
  | "request_failed"
  | "invalid_arguments"
  | "unknown_tool"
  | "operation_required"
  | "operation_conflict"
  | "budget_exhausted"
  | "rate_limit_exceeded";

export interface OperatorBackendAdapter {
  admit(request: OperatorAdmissionRequest): Promise<OperatorAdmissionResponse>;
  catalog(proof: OperatorMcpProof): Promise<OperatorCatalogResponse>;
  invoke(request: OperatorInvocationRequest): Promise<OperatorInvocationResponse>;
}

export interface CreateOperatorBackendAdapterOptions {
  baseUrl: string;
  internalSecret: string;
  requestTimeoutMs: number;
  serviceId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const ENDPOINTS = {
  admit: "/api/v1/internal/operator-copilot/mcp/admissions",
  catalog: "/api/v1/internal/operator-copilot/mcp/catalog",
  invoke: "/api/v1/internal/operator-copilot/mcp/invocations",
} as const;

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

const SAFE_BACKEND_ERROR_CODES = new Set<OperatorBackendAdapterErrorCode>([
  "invalid_arguments",
  "unknown_tool",
  "operation_required",
  "operation_conflict",
  "budget_exhausted",
  "rate_limit_exceeded",
]);

const readSafeBackendErrorCode = async (response: Response): Promise<OperatorBackendAdapterErrorCode | null> => {
  try {
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object" || !("code" in payload) || typeof payload.code !== "string") return null;
    return SAFE_BACKEND_ERROR_CODES.has(payload.code as OperatorBackendAdapterErrorCode)
      ? payload.code as OperatorBackendAdapterErrorCode
      : null;
  } catch {
    return null;
  }
};

const responseErrorCode = (status: number, backendCode: OperatorBackendAdapterErrorCode | null): OperatorBackendAdapterError["code"] => {
  if (backendCode) return backendCode;
  if (status === 401) return "unauthorized";
  if (status === 403) return "insufficient_scope";
  if (status === 429) return "rate_limit_exceeded";
  if (status >= 500) return "unavailable";
  return "request_failed";
};

export const createOperatorBackendAdapter = ({
  baseUrl,
  fetchImpl = fetch,
  internalSecret,
  now = () => new Date(),
  requestTimeoutMs,
  serviceId = "radioso-mcp-operator",
}: CreateOperatorBackendAdapterOptions): OperatorBackendAdapter => {
  const upstream = baseUrl.replace(/\/+$/u, "");

  const post = async <T>(path: string, payload: unknown, parse: (value: unknown) => T): Promise<T> => {
    const body = JSON.stringify(payload);
    const bodyDigest = sha256Digest(body);
    const timestamp = Math.floor(now().getTime() / 1_000).toString();
    const nonce = randomUUID();
    const headers = {
      "content-type": "application/json",
      [OPERATOR_SERVICE_AUTH_HEADERS.service]: serviceId,
      [OPERATOR_SERVICE_AUTH_HEADERS.timestamp]: timestamp,
      [OPERATOR_SERVICE_AUTH_HEADERS.nonce]: nonce,
      [OPERATOR_SERVICE_AUTH_HEADERS.bodyDigest]: bodyDigest,
      [OPERATOR_SERVICE_AUTH_HEADERS.signature]: createOperatorMcpRequestSignature({
        bodyDigest,
        method: "POST",
        nonce,
        path,
        secret: internalSecret,
        service: serviceId,
        timestamp,
      }),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${upstream}${path}`, { body, headers, method: "POST", signal: controller.signal });
    } catch (error) {
      throw new OperatorBackendAdapterError(isAbort(error) ? "Operator backend request timed out." : "Operator backend request failed.", 503, isAbort(error) ? "unavailable" : "request_failed");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const code = await readSafeBackendErrorCode(response);
      throw new OperatorBackendAdapterError(
        response.status === 403 ? "Operator capability scope is insufficient." : response.status >= 500 ? "Operator backend is unavailable." : "Operator authorization failed.",
        response.status,
        responseErrorCode(response.status, code),
        response.headers.get("x-radioso-required-scope") ?? undefined,
      );
    }
    try {
      return parse(await response.json());
    } catch {
      throw new OperatorBackendAdapterError("Operator backend returned an invalid response.", response.status, "invalid_response");
    }
  };

  return {
    admit(request) {
      return post(ENDPOINTS.admit, OperatorAdmissionRequestSchema.parse(request), (value) => OperatorAdmissionResponseSchema.parse(value));
    },
    catalog(proof) {
      return post(ENDPOINTS.catalog, OperatorCatalogRequestSchema.parse({ proof }), (value) => OperatorCatalogResponseSchema.parse(value));
    },
    invoke(request) {
      return post(ENDPOINTS.invoke, OperatorInvocationRequestSchema.parse(request), (value) => OperatorInvocationResponseSchema.parse(value));
    },
  };
};
