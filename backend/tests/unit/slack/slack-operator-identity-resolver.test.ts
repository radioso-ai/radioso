import { describe, expect, it, vi } from "vitest";

import { SlackOperatorIdentityResolver } from "../../../src/modules/slack/operator/slackOperatorIdentityResolver.js";
import type { WorkspaceMemberLookupResult } from "../../../src/modules/slack/operator/slackOperatorIdentityResolver.js";
import type { SlackInstallationRecord, SlackUserInfo } from "../../../src/modules/slack/public.js";

const installation: SlackInstallationRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  connectionId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  teamId: "T1",
  teamName: "Acme",
  botUserId: "UBOT",
  createdAt: new Date("2026-06-23T12:00:00.000Z"),
  updatedAt: new Date("2026-06-23T12:00:00.000Z"),
};

const createResolver = () => {
  const slack = {
    usersInfo: vi.fn(async (): Promise<SlackUserInfo> => ({
      id: "U123",
      name: "dana",
      realName: "Dana Scully",
      email: "dana@example.com",
    })),
  };
  const workspaceMembers = {
    findByEmail: vi.fn(
      async (): Promise<WorkspaceMemberLookupResult | null> => ({ accountId: "account-1", userId: "user-1" }),
    ),
  };
  const permissions = {
    hasPermission: vi.fn(async () => true),
  };
  const resolver = new SlackOperatorIdentityResolver({ slack, workspaceMembers, permissions });
  return { resolver, slack, workspaceMembers, permissions };
};

describe("SlackOperatorIdentityResolver", () => {
  it("matches a workspace member by Slack email and checks the takeover permission", async () => {
    const { resolver, slack, workspaceMembers, permissions } = createResolver();

    await expect(resolver.resolve({ installation, slackUserId: "U123" })).resolves.toEqual({
      accountId: "account-1",
      userId: "user-1",
      displayName: "Dana Scully",
    });
    expect(slack.usersInfo).toHaveBeenCalledWith("U123", installation);
    expect(workspaceMembers.findByEmail).toHaveBeenCalledWith(installation.workspaceId, "dana@example.com");
    expect(permissions.hasPermission).toHaveBeenCalledWith({
      accountId: "account-1",
      userId: "user-1",
      workspaceId: installation.workspaceId,
      permission: "workspace.conversation.takeover",
    });
  });

  it("rejects when Slack does not expose an email", async () => {
    const { resolver, slack, workspaceMembers } = createResolver();
    slack.usersInfo.mockResolvedValueOnce({ id: "U123", name: "dana" });

    await expect(resolver.resolve({ installation, slackUserId: "U123" })).resolves.toEqual({ rejected: true });
    expect(workspaceMembers.findByEmail).not.toHaveBeenCalled();
  });

  it("rejects when the email is not a workspace member", async () => {
    const { resolver, workspaceMembers, permissions } = createResolver();
    workspaceMembers.findByEmail.mockResolvedValueOnce(null);

    await expect(resolver.resolve({ installation, slackUserId: "U123" })).resolves.toEqual({ rejected: true });
    expect(permissions.hasPermission).not.toHaveBeenCalled();
  });

  it("rejects when the member lacks the takeover permission", async () => {
    const { resolver, permissions } = createResolver();
    permissions.hasPermission.mockResolvedValueOnce(false);

    await expect(resolver.resolve({ installation, slackUserId: "U123" })).resolves.toEqual({ rejected: true });
  });
});
