/**
 * Names why a federated sign-in attempt failed.
 *
 * `AuthService.federatedLogin` writes the one `auth.federated_login` failure
 * event an attempt produces, so the stages inside it label what they were doing
 * instead of recording separately. The label rides along with the error the
 * stage threw and is stripped off at the top, which keeps the error the caller
 * sees identical to the one the stage raised.
 */
export type FederatedLoginFailureReason =
  /** The identity provider has not proven control of the asserted mailbox. */
  | "email_unverified"
  /** Reading the provider link or the matching user failed. */
  | "identity_lookup_failed"
  /** Rotating the password of a never-verified account, or verifying it, failed. */
  | "account_reverification_failed"
  /** The provider link that later sign-ins match on could not be written. */
  | "identity_link_write_failed"
  /** The user exists but holds no active membership: removed or deactivated. */
  | "no_active_membership"
  /** The membership store itself faulted, so no decision could be made. */
  | "membership_lookup_failed"
  /** No workspace could be resolved or created for the account. */
  | "workspace_unavailable"
  /** The account exists but its record could not be read. */
  | "account_lookup_failed"
  /** The session could not be persisted, so no cookie could be issued. */
  | "session_write_failed"
  /** Signup is closed, so a first-time sign-in has nowhere to land. */
  | "registration_closed"
  /** An organization-creation quota refused the signup. */
  | "rate_limited"
  /** Provisioning a first-time account and workspace failed. */
  | "account_provisioning_failed"
  /** Nothing named the stage, so the failure escaped an unlabelled path. */
  | "unexpected_error";

export interface FederatedLoginFailureLabel {
  reason: FederatedLoginFailureReason;
  /** Extra audit metadata for this reason. Operator-safe values only. */
  detail?: Record<string, unknown>;
}

class LabelledFederatedLoginFailure extends Error {
  constructor(
    readonly label: FederatedLoginFailureLabel,
    readonly failure: unknown,
  ) {
    super(label.reason);
    this.name = "LabelledFederatedLoginFailure";
  }
}

/**
 * Labels a failure with the stage that raised it. The innermost label wins, so
 * a broad outer stage never overwrites a specific inner one.
 */
export const failFederatedLoginStage = (
  label: FederatedLoginFailureLabel,
  failure: unknown,
): unknown => (
  failure instanceof LabelledFederatedLoginFailure ? failure : new LabelledFederatedLoginFailure(label, failure)
);

/** Runs one stage of a sign-in, naming it if it throws. */
export const runFederatedLoginStage = async <T>(
  label: FederatedLoginFailureLabel,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (failure) {
    throw failFederatedLoginStage(label, failure);
  }
};

export const describeFederatedLoginFailure = (failure: unknown): FederatedLoginFailureLabel => (
  failure instanceof LabelledFederatedLoginFailure ? failure.label : { reason: "unexpected_error" }
);

/** Hands back the error the stage actually threw, so the caller's error is unchanged. */
export const unwrapFederatedLoginFailure = (failure: unknown): unknown => (
  failure instanceof LabelledFederatedLoginFailure ? failure.failure : failure
);
