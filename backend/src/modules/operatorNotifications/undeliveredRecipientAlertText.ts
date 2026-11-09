import { boundedMailName } from "./boundedMailName.js";

export type UndeliveredRecipientReason = "unconfirmed" | "revoked" | "suppressed";

const WHY_NOT_SENT: Record<UndeliveredRecipientReason, string> = {
  unconfirmed: "this address has not confirmed that it wants to receive them",
  revoked: "its owner stopped notifications from this workspace",
  suppressed: "an earlier email to it bounced or was reported as spam",
};

const HOW_TO_FIX: Record<UndeliveredRecipientReason, string> = {
  unconfirmed: "Ask the owner of the address to open the confirmation email, or send it again from the agent's recent notifications.",
  revoked: "Replace the address in the agent's notification recipients. Its owner can resume notifications from the link in an earlier email.",
  suppressed: "Replace the address in the agent's notification recipients.",
};

/**
 * The plain-text alert an account's administrators get when a notice skips an address: which address,
 * why, which agent, and where to fix it. Names are bounded because tenants author them.
 */
export const undeliveredRecipientAlertMessage = (input: {
  email: string;
  reason: UndeliveredRecipientReason;
  workspaceName: string;
  agentName: string;
  /** Where the agent's notifications can be fixed; omitted when the deployment has no public address. */
  dashboardUrl: string | null;
}): { subject: string; text: string } => {
  const workspaceName = boundedMailName(input.workspaceName) || "your workspace";
  const agentName = boundedMailName(input.agentName) || "an agent";
  return {
    subject: `Notifications to ${input.email} are not being delivered`,
    text: [
      `${agentName} in ${workspaceName} tried to send a notification to ${input.email}, but it was not sent because ${WHY_NOT_SENT[input.reason]}.`,
      "",
      HOW_TO_FIX[input.reason],
      ...(input.dashboardUrl ? ["", "Open the agent:", input.dashboardUrl] : []),
      "",
      `You are receiving this because you are an owner or admin of ${workspaceName}. It is sent at most once a day for each address.`,
    ].join("\n"),
  };
};
