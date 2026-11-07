import type {
  SlackBindingRepositoryPort,
  SlackInstallationRepositoryPort,
  WorkspaceAccountLookup,
} from "../public.js";

export interface SlackEscalationChannelPorts {
  installations: Pick<SlackInstallationRepositoryPort, "findByAccountId">;
  workspaceAccounts: WorkspaceAccountLookup;
  bindings: Pick<SlackBindingRepositoryPort, "findByInstallationId">;
}

type SlackEscalationChannelLookup =
  | { found: true; accountId: string; installationId: string; channelId: string }
  | {
      found: false;
      reason: "slack_workspace_not_linked" | "slack_not_installed" | "slack_escalation_channel_not_configured";
    };

/**
 * The channel a workspace's operator notifications post in: the workspace is linked to an account,
 * the account has Slack installed, and the install's binding names an escalation channel. The one
 * statement of that rule, shared by the sink that posts and the reader that asks ahead of time.
 */
export const resolveSlackEscalationChannel = async (
  ports: SlackEscalationChannelPorts,
  workspaceId: string,
): Promise<SlackEscalationChannelLookup> => {
  const accountId = await ports.workspaceAccounts.getAccountId(workspaceId);
  if (!accountId) {
    return { found: false, reason: "slack_workspace_not_linked" };
  }
  const installation = await ports.installations.findByAccountId(accountId);
  if (!installation) {
    return { found: false, reason: "slack_not_installed" };
  }
  const binding = await ports.bindings.findByInstallationId(installation.id);
  if (!binding?.escalationChannelId) {
    return { found: false, reason: "slack_escalation_channel_not_configured" };
  }
  return { found: true, accountId, installationId: installation.id, channelId: binding.escalationChannelId };
};

/** Whether a workspace's operator notifications have a Slack channel to post in. Reads only. */
export class SlackEscalationChannelReader {
  constructor(private readonly ports: SlackEscalationChannelPorts) {}

  async hasEscalationChannel(workspaceId: string): Promise<boolean> {
    return (await resolveSlackEscalationChannel(this.ports, workspaceId)).found;
  }
}
