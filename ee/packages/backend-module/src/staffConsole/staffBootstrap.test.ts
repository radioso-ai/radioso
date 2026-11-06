import { describe, expect, it, vi } from "vitest";

import { StaffBootstrapService } from "./staffBootstrap.js";
import { hashStaffPassword, verifyStaffPassword } from "./staffCrypto.js";
import type { StaffSessionRepository, StaffUserRepository } from "./staffRepository.js";
import { StaffSecurityEvents } from "./staffSecurityEvents.js";
import type { StaffRole, StaffUser } from "./staffTypes.js";

const staffUser = async (role: StaffRole): Promise<StaffUser> => ({
  id: "11111111-1111-1111-8111-111111111111",
  email: "owner@example.com",
  name: "Owner",
  passwordHash: await hashStaffPassword("old-password-123"),
  role,
  status: "disabled",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastLoginAt: null,
});

const createService = (existing: StaffUser | null) => {
  const created: StaffUser[] = [];
  const users = {
    findByEmail: vi.fn(async () => existing),
    create: vi.fn(async (input: Parameters<StaffUserRepository["create"]>[0]) => {
      const row: StaffUser = {
        id: "22222222-2222-4222-8222-222222222222",
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        role: input.role,
        status: input.status ?? "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastLoginAt: null,
      };
      created.push(row);
      return row;
    }),
    updatePassword: vi.fn(async (_id: string, passwordHash: string) =>
      existing ? { ...existing, passwordHash, status: "active" as const } : null),
  } as unknown as StaffUserRepository;
  const revokeAllForStaff = vi.fn(async () => 2);
  const sessions = { revokeAllForStaff } as unknown as StaffSessionRepository;
  const record = vi.fn(async () => undefined);
  const warn = vi.fn();
  const service = new StaffBootstrapService(users, sessions, new StaffSecurityEvents({ record }, { warn }));
  return { service, created, revokeAllForStaff, record, warn };
};

const input = { email: "Owner@Example.com", name: "Owner", password: "new-password-123" };

describe("StaffBootstrapService", () => {
  it("creates the first owner, audits it, and raises the alertable line", async () => {
    const { service, created, revokeAllForStaff, record, warn } = createService(null);

    const result = await service.bootstrapOwner(input);

    expect(result.action).toBe("create_owner");
    expect(created[0]).toMatchObject({ email: "owner@example.com", role: "owner", status: "active" });
    expect(revokeAllForStaff).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      accountId: null,
      workspaceId: null,
      eventType: "staff.bootstrap",
      eventStatus: "success",
      metadata: expect.objectContaining({ action: "create_owner", targetStaffId: created[0].id }),
    }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "staff_console.privileged_change",
      eventType: "staff.bootstrap",
    }), expect.any(String));
  });

  it("resets a locked-out owner and ends every session the old credential opened", async () => {
    const owner = await staffUser("owner");
    const { service, revokeAllForStaff, record } = createService(owner);

    const result = await service.bootstrapOwner(input);

    expect(result).toMatchObject({ action: "reset_owner", revokedSessions: 2, staff: { status: "active" } });
    await expect(verifyStaffPassword(input.password, result.staff.passwordHash)).resolves.toBe(true);
    expect(revokeAllForStaff).toHaveBeenCalledWith(owner.id);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ action: "reset_owner", revokedSessions: 2 }),
    }));
  });

  it("refuses to take over an address held by non-owner staff", async () => {
    const { service, revokeAllForStaff, record } = createService(await staffUser("support_read"));

    await expect(service.bootstrapOwner(input)).rejects.toMatchObject({ statusCode: 409 });

    expect(revokeAllForStaff).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
