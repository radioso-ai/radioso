import type { ConsentRecord, ConsentWithdrawalOutcome } from "../../../modules/privacy/public.js";
import { AppError, notFound } from "../../../shared/domain/errors.js";

/** A consent record as the history API returns it (`ConversationConsent`): its times as ISO strings. */
export const presentConsentRecord = (record: ConsentRecord) => ({
  ...record,
  slotKeys: [...record.slotKeys],
  wording: { ...record.wording },
  decidedAt: record.decidedAt.toISOString(),
  withdrawnAt: record.withdrawnAt?.toISOString() ?? null,
});

const REFUSAL_MESSAGES = {
  declined: "The visitor declined this consent, so there is nothing to withdraw",
  already_withdrawn: "This consent is already withdrawn",
} as const;

/**
 * The error a withdrawal that changed nothing answers with: 404 for a record the conversation does
 * not have, 409 `consent_not_withdrawable` with the reason and the record as it stands otherwise.
 */
export const consentWithdrawalRefusal = (outcome: Exclude<ConsentWithdrawalOutcome, { kind: "withdrawn" }>): AppError =>
  outcome.kind === "not_found"
    ? notFound("Consent record not found")
    : new AppError(409, "consent_not_withdrawable", REFUSAL_MESSAGES[outcome.reason], {
      reason: outcome.reason,
      consent: presentConsentRecord(outcome.consent),
    });
