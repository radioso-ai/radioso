import type { SlackInstallationRecord, SlackUserInfo } from "../public.js";

export interface WorkspaceMemberLookupResult {
  accountId: string;
  /** The Radioso user whose email the Slack user carries. */
  userId: string;
}

export interface WorkspaceMemberLookupPort {
  findByEmail(workspaceId: string, email: string): Promise<WorkspaceMemberLookupResult | null>;
}

/** Whether a teammate may act on conversations; answered by the same role rules the dashboard enforces. */
export interface SlackOperatorPermissionPort {
  hasPermission(input: {
    accountId: string;
    userId: string;
    workspaceId: string;
    permission: "workspace.conversation.takeover";
  }): Promise<boolean>;
}

interface SlackUserInfoLookupPort {
  usersInfo(slackUserId: string, installation?: SlackInstallationRecord): Promise<SlackUserInfo>;
}

/**
 * `displayName` is the Slack profile name, used only on Slack-side surfaces (a resolved approval
 * message, audit provenance). The teammate's Radioso name comes from handoff's operator identity.
 */
export type SlackOperatorIdentityResolution =
  | { accountId: string; userId: string; displayName: string | null }
  | { rejected: true };

const displayNameForSlackUser = (user: SlackUserInfo): string | null =>
  user.realName?.trim() || user.name?.trim() || null;

/**
 * Resolve a Slack interactivity actor to an authorized Radioso operator account, fresh on every
 * action: look up the Slack user's email, match an active workspace member, and confirm the
 * takeover permission. Nothing is persisted — operator actions are human-paced, so a single
 * `users.info` call per action is cheaper than a cache that would still have to re-check
 * authorization on every use. The display name is taken from the same live call for audit
 * provenance.
 */
export class SlackOperatorIdentityResolver {
  constructor(private readonly options: {
    slack: SlackUserInfoLookupPort;
    workspaceMembers: WorkspaceMemberLookupPort;
    permissions: SlackOperatorPermissionPort;
  }) {}

  async resolve(input: {
    installation: SlackInstallationRecord;
    workspaceId: string;
    slackUserId: string;
  }): Promise<SlackOperatorIdentityResolution> {
    const slackUser = await this.options.slack.usersInfo(input.slackUserId, input.installation);
    if (!slackUser.email) {
      return { rejected: true };
    }
    const member = await this.options.workspaceMembers.findByEmail(input.workspaceId, slackUser.email);
    if (!member) {
      return { rejected: true };
    }
    const authorized = await this.options.permissions.hasPermission({
      accountId: member.accountId,
      userId: member.userId,
      workspaceId: input.workspaceId,
      permission: "workspace.conversation.takeover",
    });
    if (!authorized) {
      return { rejected: true };
    }
    return {
      accountId: member.accountId,
      userId: member.userId,
      displayName: displayNameForSlackUser(slackUser),
    };
  }
}
