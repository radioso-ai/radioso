import { serviceUnavailable } from "../../domain/errors.js";
import { isProviderRequestTimeoutError } from "./providerTimeouts.js";

type ProviderErrorShape = {
  status?: number;
  code?: string;
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
  message?: string;
};

// Thrown by provider clients that drive `fetch` directly (Gemini, Claude) so
// downstream classifiers can read the HTTP status without parsing the message.
// OpenAI's SDK already throws structurally compatible errors.
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly provider: string;
  readonly operation: string;

  constructor(input: { provider: string; operation: string; status: number }) {
    super(`${input.provider} ${input.operation} failed with status ${input.status}`);
    this.name = "ProviderHttpError";
    this.status = input.status;
    this.provider = input.provider;
    this.operation = input.operation;
  }
}

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

  return code === "invalid_api_key" || status === 401;
};

export const getProviderCredentialErrorMessage = () =>
  "The configured AI provider rejected the credentials. Update .env and restart Radioso.";

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
