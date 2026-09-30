import { describe, expect, it, vi } from "vitest";

import { createConversationOperatorDirectory } from "../../../src/app/composition/conversationOperatorDirectory.js";
import type { AccountMembershipUserRecord } from "../../../src/db/repositories/accountMembershipRepository.js";

const member = (overrides: Partial<AccountMembershipUserRecord> & Pick<AccountMembershipUserRecord, "userId" | "email">): AccountMembershipUserRecord => ({
  id: `membership-${overrides.userId}`,
  accountId: "account-1",
  role: "member",
  status: "active",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  displayName: null,
  disabledAt: null,
  ...overrides,
});

const directoryWith = (members: AccountMembershipUserRecord[], permitted: (userId: string) => boolean) => {
  const accountAccess = {
    listMembersWithWorkspacePermission: vi.fn(async () =>
      members.filter((member) => member.disabledAt === null && permitted(member.userId))),
    findAccountUser: vi.fn(async (_accountId: string, userId: string) =>
      members.find((member) => member.userId === userId) ?? null),
    hasPermission: vi.fn(async (input: { userId?: string | null }) => permitted(input.userId ?? "")),
  };
  return { accountAccess, directory: createConversationOperatorDirectory({ accountAccess }) };
};

describe("conversation operator directory", () => {
  it("lists the active teammates who hold takeover on the workspace, by teammate label", async () => {
    const { accountAccess, directory } = directoryWith([
      member({ userId: "user-dana", email: "dana@example.com", displayName: "Dana Scully" }),
      member({ userId: "user-fox", email: "fox@example.com" }),
      member({ userId: "user-skinner", email: "skinner@example.com" }),
      member({ userId: "user-gone", email: "gone@example.com", disabledAt: new Date("2026-09-02T00:00:00.000Z") }),
    ], (userId) => userId !== "user-skinner");

    await expect(directory.list({ accountId: "account-1", workspaceId: "workspace-1" })).resolves.toEqual([
      { userId: "user-dana", label: "Dana Scully" },
      { userId: "user-fox", label: "fox@example.com" },
    ]);
    // One bulk eligibility read, not a permission check per member.
    expect(accountAccess.listMembersWithWorkspacePermission).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      permission: "workspace.conversation.takeover",
    });
    expect(accountAccess.hasPermission).not.toHaveBeenCalled();
  });

  it("finds one eligible teammate and nobody else", async () => {
    const { directory } = directoryWith([
      member({ userId: "user-dana", email: "dana@example.com", displayName: "Dana Scully" }),
      member({ userId: "user-skinner", email: "skinner@example.com" }),
      member({ userId: "user-gone", email: "gone@example.com", disabledAt: new Date("2026-09-02T00:00:00.000Z") }),
    ], (userId) => userId !== "user-skinner");
    const scope = { accountId: "account-1", workspaceId: "workspace-1" };

    await expect(directory.find({ ...scope, userId: "user-dana" })).resolves.toEqual({ userId: "user-dana", label: "Dana Scully" });
    await expect(directory.find({ ...scope, userId: "user-skinner" })).resolves.toBeNull();
    await expect(directory.find({ ...scope, userId: "user-gone" })).resolves.toBeNull();
    await expect(directory.find({ ...scope, userId: "user-stranger" })).resolves.toBeNull();
  });

  it("checks only the one teammate it is asked about", async () => {
    const { accountAccess, directory } = directoryWith([
      member({ userId: "user-dana", email: "dana@example.com", displayName: "Dana Scully" }),
      member({ userId: "user-fox", email: "fox@example.com" }),
      member({ userId: "user-gone", email: "gone@example.com", disabledAt: new Date("2026-09-02T00:00:00.000Z") }),
    ], () => true);

    await directory.find({ accountId: "account-1", workspaceId: "workspace-1", userId: "user-fox" });
    await directory.find({ accountId: "account-1", workspaceId: "workspace-1", userId: "user-gone" });

    expect(accountAccess.listMembersWithWorkspacePermission).not.toHaveBeenCalled();
    expect(accountAccess.findAccountUser).toHaveBeenCalledTimes(2);
    expect(accountAccess.findAccountUser).toHaveBeenCalledWith("account-1", "user-fox");
    // A disabled user is ruled out before any permission resolution.
    expect(accountAccess.hasPermission).toHaveBeenCalledTimes(1);
    expect(accountAccess.hasPermission).toHaveBeenCalledWith({
      accountId: "account-1",
      userId: "user-fox",
      workspaceId: "workspace-1",
      permission: "workspace.conversation.takeover",
    });
  });
});
