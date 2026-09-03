import type {
  AccountInvitationNotification,
  AccountInvitationNotificationResult,
  AccountInvitationNotifier,
} from "../../modules/account/contracts/accountInvitationNotifier.js";
import {
  readMailErrorClass,
  readMailProviderErrorName,
  readMailProviderStatusCode,
  type EmailService,
} from "../../modules/mail/public.js";
import { renderAccountInvitationEmail } from "../../modules/mail/templates/accountInvitationEmail.js";

const DEFAULT_APP_BASE_URL = "http://localhost:3000";

interface AccountInvitationNotifierLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export const createMailAccountInvitationNotifier = (input: {
  env: { APP_BASE_URL?: string };
  mailService: EmailService;
  logger?: AccountInvitationNotifierLogger;
}): AccountInvitationNotifier => ({
  async notifyInvited(
    notification: AccountInvitationNotification,
  ): Promise<AccountInvitationNotificationResult> {
    const acceptanceUrl = new URL(
      notification.acceptancePath,
      input.env.APP_BASE_URL ?? DEFAULT_APP_BASE_URL,
    ).toString();

    try {
      // A deployment without a configured mail provider is not a failure, so the driver's own
      // report decides delivery rather than the absence of a thrown error.
      const { dispatched } = await input.mailService.send(renderAccountInvitationEmail({
        to: notification.email,
        acceptanceUrl,
        invitedByEmail: notification.invitedByEmail,
        expiresAt: notification.expiresAt,
      }));
      return { delivered: dispatched };
    } catch (error) {
      // The invitee mailbox and acceptance link stay out of the log; the operator already
      // holds both, and the token would outlive the log line.
      input.logger?.warn(
        {
          event: "account_invitation_mail_delivery_failed",
          errorClass: readMailErrorClass(error),
          providerStatusCode: readMailProviderStatusCode(error),
          providerErrorName: readMailProviderErrorName(error),
        },
        "Account invitation mail delivery failed",
      );
      return { delivered: false };
    }
  },
});
