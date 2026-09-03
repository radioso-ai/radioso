import {
  readMailErrorClass,
  readMailProviderErrorName,
  readMailProviderStatusCode,
} from "../../mail/public.js";

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
      errorClass: readMailErrorClass(input.error),
      providerStatusCode: readMailProviderStatusCode(input.error),
      providerErrorName: readMailProviderErrorName(input.error),
    },
    "Transactional auth mail delivery failed",
  );
};

export type { AuthMailDeliveryLogger };
