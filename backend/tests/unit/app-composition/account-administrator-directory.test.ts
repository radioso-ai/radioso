import { describe, expect, it, vi } from "vitest";

import { createAccountAdministratorDirectory } from "../../../src/app/composition/accountAdministratorDirectory.js";

const membership = (overrides: Partial<{
  role: "owner" | "admin" | "member";
  email: string;
  displayName: string | null;
  disabledAt: Date | null;
}> = {}) => ({
  id: "membership-1",
  accountId: "account-1",
  userId: "user-1",
  role: "member" as const,
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
  email: "person@example.com",
  displayName: "Person",
  disabledAt: null,
  ...overrides,
});

describe("createAccountAdministratorDirectory", () => {
  it("returns active owners and admins, mapped to email and display name", async () => {
    const repository = {
      listActiveByAccount: vi.fn().mockResolvedValue([
        membership({ role: "owner", email: "owner@example.com", displayName: "Owner" }),
        membership({ role: "admin", email: "admin@example.com", displayName: "Admin" }),
        membership({ role: "member", email: "member@example.com", displayName: "Member" }),
      ]),
    };
    const directory = createAccountAdministratorDirectory(repository);

    const result = await directory.list("account-1");

    expect(repository.listActiveByAccount).toHaveBeenCalledWith("account-1");
    expect(result).toEqual([
      { email: "owner@example.com", displayName: "Owner" },
      { email: "admin@example.com", displayName: "Admin" },
    ]);
  });

  it("excludes a disabled owner or admin", async () => {
    const repository = {
      listActiveByAccount: vi.fn().mockResolvedValue([
        membership({ role: "owner", email: "owner@example.com", disabledAt: new Date("2026-01-01") }),
        membership({ role: "admin", email: "admin@example.com" }),
      ]),
    };
    const directory = createAccountAdministratorDirectory(repository);

    const result = await directory.list("account-1");

    expect(result).toEqual([{ email: "admin@example.com", displayName: "Person" }]);
  });

  it("returns an empty list when the account has no administrators", async () => {
    const repository = { listActiveByAccount: vi.fn().mockResolvedValue([]) };
    const directory = createAccountAdministratorDirectory(repository);

    await expect(directory.list("account-1")).resolves.toEqual([]);
  });
});
