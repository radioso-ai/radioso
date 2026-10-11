import { AppError } from "../../../shared/domain/errors.js";
import type { SendHaltReason } from "../outbound/sendAuthority.js";

/** What the teammate must do before replies can go out, named in the refusal (FR-004). */
const MISSING_STEP: Readonly<Record<SendHaltReason, { step: string; message: string }>> = {
  sending_not_verified: {
    step: "verify_sending_domain",
    message: "Replies to this email conversation can be sent once its sending domain is verified.",
  },
  domain_removed: {
    step: "add_sending_domain",
    message: "Replies to this email conversation cannot be sent: its sending domain was removed.",
  },
  mailbox_removed: {
    step: "add_mailbox",
    message: "Replies to this email conversation cannot be sent: its mailbox was removed.",
  },
};

/**
 * `409 email_sending_not_verified`, naming the missing step: the refusal a teammate's send gets
 * before anything is written when the mailbox cannot send as its address.
 */
export const emailSendingRefusal = (reason: SendHaltReason, domain: string | null): AppError => {
  const missing = MISSING_STEP[reason];
  return new AppError(409, "email_sending_not_verified", missing.message, { step: missing.step, ...(domain ? { domain } : {}) });
};
