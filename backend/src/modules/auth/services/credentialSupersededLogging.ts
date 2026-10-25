interface CredentialSupersededLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

/** The session issuers that write only under the credential generation they read. */
type CredentialGuardedFlow =
  | "registration"
  | "password_login"
  | "federated_login"
  | "invitation_accept"
  | "account_switch"
  | "organization_create"
  | "password_reset";

/**
 * Logs a sign-in refused because a password reset or federated recovery
 * advanced the user's credential generation after the sign-in read it. Ids
 * only: the attempt's audit record, where the flow keeps one, holds the rest.
 */
export const logCredentialSuperseded = (
  logger: CredentialSupersededLogger | undefined,
  input: { flow: CredentialGuardedFlow; userId: string; accountId?: string },
): void => {
  logger?.warn(
    {
      event: "auth.credential_superseded",
      flow: input.flow,
      userId: input.userId,
      ...(input.accountId ? { accountId: input.accountId } : {}),
    },
    "Sign-in refused: the user's credentials changed after it read them",
  );
};

export type { CredentialGuardedFlow, CredentialSupersededLogger };
