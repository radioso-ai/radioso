import type { SlackInstallationRecord, SlackUserInfo } from "../public.js";
import type { SlackOperatorIdentityRepositoryPort } from "../persistence/slackOperatorIdentityRepository.js";

export interface WorkspaceMemberLookupResult {
  accountId: string;
  userId?: string | null;
}

export interface WorkspaceMemberLookupPort {
  findByEmail(workspaceId: string, email: string): Promise<WorkspaceMemberLookupResult | null>;
}

export interface SlackOperatorPermissionPort {
  hasPermission(input: {
    accountId: string;
    userId?: string | null;
    workspaceId: string;
    permission: "workspace.conversation.takeover";
  }): Promise<boolean>;
}

export interface SlackUserInfoLookupPort {
  usersInfo(slackUserId: string, installation?: SlackInstallationRecord): Promise<SlackUserInfo>;
}

export type SlackOperatorIdentityResolution =
  | { accountId: string; displayName: string | null }
  | { rejected: true };

const displayNameForSlackUser = (user: SlackUserInfo): string | null =>
  user.realName?.trim() || user.name?.trim() || null;

export class SlackOperatorIdentityResolver {
  constructor(private readonly options: {
    identities: SlackOperatorIdentityRepositoryPort;
    slack: SlackUserInfoLookupPort;
    workspaceMembers: WorkspaceMemberLookupPort;
    permissions: SlackOperatorPermissionPort;
  }) {}

  async resolve(input: {
    installation: SlackInstallationRecord;
    slackUserId: string;
  }): Promise<SlackOperatorIdentityResolution> {
    const cached = await this.options.identities.findByInstallationAndSlackUser({
      installationId: input.installation.id,
      slackUserId: input.slackUserId,
    });
    if (cached) {
      const authorized = await this.options.permissions.hasPermission({
        accountId: cached.accountId,
        workspaceId: input.installation.workspaceId,
        permission: "workspace.conversation.takeover",
      });
      return authorized
        ? { accountId: cached.accountId, displayName: cached.slackDisplayName }
        : { rejected: true };
    }

    const slackUser = await this.options.slack.usersInfo(input.slackUserId, input.installation);
    if (!slackUser.email) {
      return { rejected: true };
    }
    const member = await this.options.workspaceMembers.findByEmail(input.installation.workspaceId, slackUser.email);
    if (!member) {
      return { rejected: true };
    }
    const authorized = await this.options.permissions.hasPermission({
      accountId: member.accountId,
      userId: member.userId,
      workspaceId: input.installation.workspaceId,
      permission: "workspace.conversation.takeover",
    });
    if (!authorized) {
      return { rejected: true };
    }

    const displayName = displayNameForSlackUser(slackUser);
    await this.options.identities.upsert({
      workspaceId: input.installation.workspaceId,
      installationId: input.installation.id,
      slackUserId: input.slackUserId,
      accountId: member.accountId,
      slackDisplayName: displayName,
    });
    return { accountId: member.accountId, displayName };
  }
}
