import { describe, expect, it, vi } from "vitest";

import { SlackOperatorIdentityResolver } from "../../../src/modules/slack/operator/slackOperatorIdentityResolver.js";
import type { SlackInstallationRecord, SlackUserInfo } from "../../../src/modules/slack/public.js";
import type { SlackOperatorIdentityRecord } from "../../../src/modules/slack/persistence/slackOperatorIdentityRepository.js";

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

const cachedIdentity = {
  id: "identity-1",
  workspaceId: installation.workspaceId,
  installationId: installation.id,
  slackUserId: "U123",
  accountId: "account-1",
  slackDisplayName: "Cached Dana",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const createResolver = (overrides: Partial<ConstructorParameters<typeof SlackOperatorIdentityResolver>[0]> = {}) => {
  const identities = {
    findByInstallationAndSlackUser: vi.fn(async (): Promise<SlackOperatorIdentityRecord | null> => null),
    upsert: vi.fn(async () => cachedIdentity),
  };
  const slack = {
    usersInfo: vi.fn(async (): Promise<SlackUserInfo> => ({
      id: "U123",
      name: "dana",
      realName: "Dana Scully",
      email: "dana@example.com",
    })),
  };
  const workspaceMembers = {
    findByEmail: vi.fn(async () => ({ accountId: "account-1", userId: "user-1" })),
  };
  const permissions = {
    hasPermission: vi.fn(async () => true),
  };
  const resolver = new SlackOperatorIdentityResolver({
    identities,
    slack,
    workspaceMembers,
    permissions,
    ...overrides,
  });
  return { resolver, identities, slack, workspaceMembers, permissions };
};

describe("SlackOperatorIdentityResolver", () => {
  it("returns a cached identity after re-checking current authorization", async () => {
    const { resolver, identities, slack, permissions } = createResolver();
    identities.findByInstallationAndSlackUser.mockResolvedValueOnce(cachedIdentity);

    await expect(resolver.resolve({ installation, slackUserId: "U123" })).resolves.toEqual({
      accountId: "account-1",
      displayName: "Cached Dana",
    });
    expect(permissions.hasPermission).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: installation.workspaceId,
      permission: "workspace.conversation.takeover",
    });
    expect(slack.usersInfo).not.toHaveBeenCalled();
  });

  it("looks up Slack email, matches a workspace member, checks permission, and caches the identity", async () => {
    const { resolver, identities, slack, workspaceMembers } = createResolver();

    await expect(resolver.resolve({ installation, slackUserId: "U123" })).resolves.toEqual({
      accountId: "account-1",
      displayName: "Dana Scully",
    });
    expect(slack.usersInfo).toHaveBeenCalledWith("U123", installation);
    expect(workspaceMembers.findByEmail).toHaveBeenCalledWith(installation.workspaceId, "dana@example.com");
    expect(identities.upsert).toHaveBeenCalledWith({
      workspaceId: installation.workspaceId,
      installationId: installation.id,
      slackUserId: "U123",
      accountId: "account-1",
      slackDisplayName: "Dana Scully",
    });
  });

  it("rejects a cached identity when the account no longer has takeover permission", async () => {
    const { resolver, identities, slack, permissions } = createResolver();
    identities.findByInstallationAndSlackUser.mockResolvedValueOnce(cachedIdentity);
    permissions.hasPermission.mockResolvedValue(false);

    await expect(resolver.resolve({ installation, slackUserId: "U123" })).resolves.toEqual({ rejected: true });
    expect(slack.usersInfo).not.toHaveBeenCalled();
  });

  it("rejects when Slack does not expose an email", async () => {
    const { resolver, slack, workspaceMembers } = createResolver();
    slack.usersInfo.mockResolvedValueOnce({ id: "U123", name: "dana" });

    await expect(resolver.resolve({ installation, slackUserId: "U123" })).resolves.toEqual({ rejected: true });
    expect(workspaceMembers.findByEmail).not.toHaveBeenCalled();
  });

  it("rejects when the email is not an authorized workspace member", async () => {
    const { resolver, workspaceMembers, permissions, identities } = createResolver();
    workspaceMembers.findByEmail.mockResolvedValueOnce({ accountId: "account-1", userId: "user-1" });
    permissions.hasPermission.mockResolvedValueOnce(false);

    await expect(resolver.resolve({ installation, slackUserId: "U123" })).resolves.toEqual({ rejected: true });
    expect(identities.upsert).not.toHaveBeenCalled();
  });
});
