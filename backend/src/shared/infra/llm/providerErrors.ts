import { serviceUnavailable } from "../../domain/errors.js";
import { isProviderRequestTimeoutError } from "./providerTimeouts.js";

type ProviderErrorShape = {
  status?: number;
  code?: string;
  error?: {
    message?: string;
    code?: string;
    type?: string;
    status?: string;
  };
  message?: string;
};

interface ProviderHttpErrorInput {
  provider: string;
  operation: string;
  status: number;
  bodyText?: string;
  bodyJson?: Record<string, unknown>;
}

const CREDENTIAL_ERROR_CODE = "invalid_api_key";
const GENERIC_PROVIDER_HTTP_ERROR_CODE = "provider_http_error";
// Structural shape of a machine code (`RESOURCE_EXHAUSTED`, `overloaded_error`), never prose.
const MACHINE_CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

const machineCode = (value: string | undefined): string | undefined =>
  value !== undefined && MACHINE_CODE_SHAPE.test(value) ? value : undefined;

/**
 * Structured error thrown by raw HTTP provider adapters (Gemini / Claude / generic
 * fetch-based clients). Mirrors the OpenAI SDK's error shape so
 * `isProviderCredentialError` can detect auth failures uniformly.
 *
 * `message` may echo provider text, which can include customer content; it is for
 * in-process handling only. Telemetry records `code` and `status`, never `message`.
 */
export class ProviderHttpError extends Error implements ProviderErrorShape {
  readonly status: number;
  readonly provider: string;
  readonly operation: string;
  /** The provider's machine code (code, status enum, or error type), never prose. */
  readonly code: string;
  readonly error?: ProviderErrorShape["error"];
  readonly bodyText: string;

  constructor(input: ProviderHttpErrorInput) {
    const innerError = extractInnerProviderError(input.bodyJson);
    const looksLikeAuth = isAuthFailureResponse(input.status, innerError);
    const message = innerError?.message
      ? `${input.provider} ${input.operation} failed: ${input.status} ${innerError.message}`
      : `${input.provider} ${input.operation} failed with status ${input.status}`;
    super(message);
    this.name = "ProviderHttpError";
    this.provider = input.provider;
    this.operation = input.operation;
    // Surface 401 for auth failures so existing detection (status === 401)
    // works for vendors that report invalid API keys with a different HTTP code.
    this.status = looksLikeAuth ? 401 : input.status;
    this.code = looksLikeAuth
      ? CREDENTIAL_ERROR_CODE
      : machineCode(innerError?.code) ?? machineCode(innerError?.status) ?? machineCode(innerError?.type)
        ?? GENERIC_PROVIDER_HTTP_ERROR_CODE;
    if (innerError) {
      this.error = {
        message: innerError.message,
        code: innerError.code,
        type: innerError.type,
        status: innerError.status,
      };
    }
    this.bodyText = input.bodyText ?? "";
  }
}

const extractInnerProviderError = (
  bodyJson: Record<string, unknown> | undefined,
): { message?: string; code?: string; type?: string; status?: string } | undefined => {
  if (!bodyJson) {
    return undefined;
  }
  const candidate = (bodyJson.error ?? bodyJson) as Record<string, unknown> | undefined;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }
  return {
    message: typeof candidate.message === "string" ? candidate.message : undefined,
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    type: typeof candidate.type === "string" ? candidate.type : undefined,
    status: typeof candidate.status === "string" ? candidate.status : undefined,
  };
};

const isAuthFailureResponse = (
  status: number,
  innerError: { code?: string; type?: string; status?: string } | undefined,
): boolean => {
  if (status === 401 || status === 403) {
    return true;
  }
  // Gemini reports an invalid API key with HTTP 400 + structural status
  // `INVALID_ARGUMENT` / `UNAUTHENTICATED`. Anthropic uses `authentication_error`
  // as the type field. Both are structural — not English copy.
  if (status === 400 && innerError?.status === "INVALID_ARGUMENT") {
    return true;
  }
  if (innerError?.status === "UNAUTHENTICATED" || innerError?.status === "PERMISSION_DENIED") {
    return true;
  }
  if (innerError?.type === "authentication_error") {
    return true;
  }
  if (innerError?.code === CREDENTIAL_ERROR_CODE) {
    return true;
  }
  return false;
};

export const readProviderErrorBody = async (
  providerName: string,
  operation: string,
  response: Response,
): Promise<ProviderHttpError> => {
  const bodyText = await response.text().catch(() => "");
  let bodyJson: Record<string, unknown> | undefined;
  if (bodyText) {
    try {
      bodyJson = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      bodyJson = undefined;
    }
  }
  return new ProviderHttpError({
    provider: providerName,
    operation,
    status: response.status,
    bodyText,
    bodyJson,
  });
};

const getStatus = (error: ProviderErrorShape) => error.status;

const getCode = (error: ProviderErrorShape) => error.code ?? error.error?.code;

const getMessage = (error: ProviderErrorShape) => error.error?.message ?? error.message;

export const isProviderCredentialError = (error: unknown): error is ProviderErrorShape => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const providerError = error as ProviderErrorShape;
  const code = getCode(providerError);
  const status = getStatus(providerError);

  return code === CREDENTIAL_ERROR_CODE || status === 401;
};

const getProviderCredentialErrorMessage = () =>
  "The AI provider rejected the credentials. Replace the workspace API key at Settings → Credentials, or update the matching environment variable (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_COMPATIBLE_API_KEY) and restart Radioso.";

export const normalizeProviderCredentialError = (error: unknown) => {
  if (!isProviderCredentialError(error)) {
    return error;
  }

  return serviceUnavailable(getProviderCredentialErrorMessage(), {
    reason: getMessage(error),
    providerIssue: "credentials_rejected",
  });
};

export const getProviderFailureReason = (error: unknown) => {
  if (isProviderRequestTimeoutError(error)) {
    return error.message;
  }

  if (isProviderCredentialError(error)) {
    return getProviderCredentialErrorMessage();
  }

  return error instanceof Error ? error.message : "Unknown document processing error";
};

// HTTP status codes that should be retried even though they are 4xx:
// request-timeout, conflict, and rate-limit are typically transient.
const RETRYABLE_4XX_STATUSES = new Set([408, 409, 425, 429]);

// True for errors the provider has told us will not change on retry — e.g.,
// rejected credentials or malformed payloads. The worker uses this to fail
// fast instead of burning retry budget on permanent failures.
export const isPermanentProviderFailure = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  if (isProviderRequestTimeoutError(error)) {
    return false;
  }

  if (isProviderCredentialError(error)) {
    return true;
  }

  const providerError = error as ProviderErrorShape;
  const status = getStatus(providerError);
  if (typeof status === "number" && status >= 400 && status < 500 && !RETRYABLE_4XX_STATUSES.has(status)) {
    return true;
  }

  return false;
};
