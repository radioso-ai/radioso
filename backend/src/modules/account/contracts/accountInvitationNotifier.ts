export interface AccountInvitationNotification {
  /** Mailbox the invitation was addressed to, already normalized. */
  email: string;
  /** Origin-relative acceptance path, e.g. `/invite/<token>`. */
  acceptancePath: string;
  /** Mailbox of the operator who issued the invitation, when it can be resolved. */
  invitedByEmail: string | null;
  expiresAt: Date;
}

export interface AccountInvitationNotificationResult {
  delivered: boolean;
}

/**
 * Invitation delivery is best-effort: an invitation stays valid and shareable by link
 * even when notification fails, so implementations report the outcome instead of throwing.
 */
export interface AccountInvitationNotifier {
  notifyInvited(notification: AccountInvitationNotification): Promise<AccountInvitationNotificationResult>;
}
