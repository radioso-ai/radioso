import { serviceUnavailable } from "../../domain/errors.js";

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
  if (isProviderCredentialError(error)) {
    return getProviderCredentialErrorMessage();
  }

  return error instanceof Error ? error.message : "Unknown document processing error";
};
