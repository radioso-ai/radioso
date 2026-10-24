import { LettermintWebhookVerifier } from "./adapters/lettermintWebhook.js";
import { ResendWebhookVerifier } from "./adapters/resendWebhook.js";
import { resolveMailDriverName } from "./emailService.js";
import type { InboundVerification } from "./inboundEmailReceiver.js";

/**
 * The provider webhook that reports delivery of transactional mail, verified by whichever provider
 * sends that mail. Consumer: the notification delivery webhook route, which knows no provider.
 */

export type MailWebhookEnv = { MAIL_DRIVER?: string; RESEND_MAIL_API_KEY?: string; LETTERMINT_PROJECT_TOKEN?: string };

export interface DeliveryWebhookVerifier {
  readonly provider: "resend" | "lettermint";
  verify(request: {
    rawBody: Buffer;
    headers: Readonly<Record<string, string | undefined>>;
    now: Date;
  }): InboundVerification;
}

/** The verifier for the transactional mail driver `source` resolves to: Lettermint's when that driver is lettermint, Resend's otherwise (today's behaviour). */
export const deliveryWebhookVerifierFor = (
  source: MailWebhookEnv,
  secrets: { current: string; previous: string | null },
): DeliveryWebhookVerifier => {
  if (resolveMailDriverName(source) === "lettermint") {
    const verifier = new LettermintWebhookVerifier(secrets);
    return { provider: "lettermint", verify: (request) => verifier.verify(request) };
  }
  const verifier = new ResendWebhookVerifier(secrets);
  return { provider: "resend", verify: (request) => verifier.verify(request) };
};
