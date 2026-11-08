import { knownAgentId } from "./notificationDelivery.js";
import type { RecipientPolicySkipReason, SkippedRecipient } from "./notificationRecipientPolicy.js";
import type { UndeliveredRecipientAlertStore } from "./undeliveredRecipientAlert.js";

/** The workspace's administrators who get a notice in place of the configured addresses policy left out. */
export interface AdministratorFallbackPlan {
  /** Normalized addresses, each mailed its own copy. */
  recipients: string[];
  /** The line that opens their copy: which address missed the notice, why, and where that is fixed. */
  note: string;
}

export interface NotificationAdministratorFallbackPort {
  /**
   * Who gets a notice that recipient policy kept from every configured address, and what their copy
   * opens with; null when no administrator can be mailed.
   */
  plan(input: {
    workspaceId: string;
    agentId: string | null;
    skipped: readonly SkippedRecipient[];
  }): Promise<AdministratorFallbackPlan | null>;
}

const WHY_IT_CANNOT_RECEIVE: Record<RecipientPolicySkipReason, string> = {
  unconfirmed: "the address has not confirmed yet that it wants notifications",
  revoked: "its owner stopped notifications from this workspace",
  suppressed: "an earlier email to it bounced or was reported as spam",
};

/** One line, in plain English, so it reads above any notice without changing the notice. */
const administratorFallbackNote = (skipped: readonly SkippedRecipient[], dashboardUrl: string | null): string => {
  const why = skipped.length === 1
    ? `${skipped[0].email} cannot receive it: ${WHY_IT_CANNOT_RECEIVE[skipped[0].reason]}.`
    : `none of its addresses can receive it. ${skipped.map(({ email, reason }) => `${email}: ${WHY_IT_CANNOT_RECEIVE[reason]}.`).join(" ")}`;
  const fix = dashboardUrl ? ` Fix it on the agent's page: ${dashboardUrl}` : "";
  return `This notification came to you because ${why}${fix}`;
};

/**
 * Sends a notice that no configured address can receive to the people who can fix that: the
 * account's verified owners and admins, and the members a grant makes admins of this workspace,
 * the same audience the undelivered-recipient alert reaches. Their copy is the notice itself with
 * one line on top, so the request still reaches a person while the address waits to be fixed.
 */
export class NotificationAdministratorFallback implements NotificationAdministratorFallbackPort {
  constructor(private readonly options: {
    administrators: Pick<UndeliveredRecipientAlertStore, "listAdministratorEmails">;
    /** The dashboard page where the agent's notifications are fixed, when the deployment has one. */
    dashboardUrl: (input: { workspaceId: string; agentId: string | null }) => Promise<string | null>;
  }) {}

  async plan(input: {
    workspaceId: string;
    agentId: string | null;
    skipped: readonly SkippedRecipient[];
  }): Promise<AdministratorFallbackPlan | null> {
    const recipients = await this.options.administrators.listAdministratorEmails(input.workspaceId);
    if (recipients.length === 0) return null;
    // A missing link costs the administrator a click, not the notice.
    const dashboardUrl = await this.options
      .dashboardUrl({ workspaceId: input.workspaceId, agentId: knownAgentId(input.agentId) })
      .catch(() => null);
    return { recipients, note: administratorFallbackNote(input.skipped, dashboardUrl) };
  }
}
