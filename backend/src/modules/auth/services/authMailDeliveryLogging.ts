interface AuthMailDeliveryLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

type AuthMailDeliveryFlow = "email_verification" | "password_reset";

interface AuthMailDeliveryFailureInput {
  flow: AuthMailDeliveryFlow;
  userId: string;
  tokenRecordId: string;
  error: unknown;
}

const readProviderStatusCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return undefined;
  }
  const statusCode = error.statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
};

const readProviderErrorName = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object" || !("providerErrorName" in error)) {
    return undefined;
  }
  const providerErrorName = error.providerErrorName;
  return typeof providerErrorName === "string" && providerErrorName.length > 0
    ? providerErrorName
    : undefined;
};

export const logAuthMailDeliveryFailure = (
  logger: AuthMailDeliveryLogger | undefined,
  input: AuthMailDeliveryFailureInput,
): void => {
  logger?.warn(
    {
      event: "auth_mail_delivery_failed",
      flow: input.flow,
      userId: input.userId,
      tokenRecordId: input.tokenRecordId,
      errorClass: input.error instanceof Error ? input.error.name : typeof input.error,
      providerStatusCode: readProviderStatusCode(input.error),
      providerErrorName: readProviderErrorName(input.error),
    },
    "Transactional auth mail delivery failed",
  );
};

export type { AuthMailDeliveryLogger };
