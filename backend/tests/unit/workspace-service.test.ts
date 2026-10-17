import { describe, expect, it, vi } from "vitest";

import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import {
  InMemoryAccountMembershipRepository,
  InMemoryWorkspaceRepository,
  createAuditService,
} from "../support/fakes.js";

describe("workspace service", () => {
  it("creates workspaces with a numeric public route key", async () => {
    const service = new WorkspaceService(new InMemoryWorkspaceRepository(), createAuditService());

    const workspace = await service.create("account-1", "Customer Support");

    expect(workspace.publicRouteKey).toMatch(/^\d{10}$/);
  });

  it("keeps public route keys independent from the workspace name", async () => {
    const service = new WorkspaceService(new InMemoryWorkspaceRepository(), createAuditService());

    const workspace = await service.create(
      "account-1",
      "This workspace name is intentionally much longer than the canonical route should expose",
    );

    expect(workspace.publicRouteKey).toMatch(/^\d{10}$/);
    expect(workspace.publicRouteKey).not.toContain("workspace");
    expect(workspace.publicRouteKey.length).toBe(10);
  });

  it("keeps the public route key stable when a workspace is renamed", async () => {
    const repository = new InMemoryWorkspaceRepository();
    const service = new WorkspaceService(repository, createAuditService());
    const workspace = await service.create("account-1", "Original Name");

    const renamed = await service.rename(workspace.id, "account-1", "Renamed Workspace");

    expect(renamed.publicRouteKey).toBe(workspace.publicRouteKey);
  });

  it("resolves an accessible workspace by public route key for a member", async () => {
    const repository = new InMemoryWorkspaceRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    const service = new WorkspaceService(repository, createAuditService(), membershipRepository);
    const workspace = await service.create("account-1", "Shared Space");
    await membershipRepository.create({
      accountId: "account-1",
      userId: "user-1",
      role: "owner",
    });

    await expect(service.resolveAccessibleByPublicRouteKey("user-1", workspace.publicRouteKey)).resolves.toMatchObject({
      id: workspace.id,
      accountId: "account-1",
    });
  });

  it("rejects inaccessible public route keys with a not found error", async () => {
    const repository = new InMemoryWorkspaceRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    const service = new WorkspaceService(repository, createAuditService(), membershipRepository);
    const workspace = await service.create("account-1", "Private Space");

    await expect(service.resolveAccessibleByPublicRouteKey("user-2", workspace.publicRouteKey)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rename refuses to mutate a workspace belonging to a different account", async () => {
    const repository = new InMemoryWorkspaceRepository();
    const service = new WorkspaceService(repository, createAuditService());
    const workspace = await service.create("account-1", "Owned");

    await expect(service.rename(workspace.id, "account-2", "Hijacked")).rejects.toMatchObject({
      code: "not_found",
    });

    const untouched = await repository.findByIdAndAccountId(workspace.id, "account-1");
    expect(untouched?.name).toBe("Owned");
  });

  it("delete refuses to mutate a workspace belonging to a different account", async () => {
    const repository = new InMemoryWorkspaceRepository();
    const service = new WorkspaceService(repository, createAuditService());
    await service.create("account-1", "Keep");
    const target = await service.create("account-1", "Owned");

    await expect(service.delete(target.id, "account-2")).rejects.toMatchObject({
      code: "not_found",
    });

    const survivor = await repository.findByIdAndAccountId(target.id, "account-1");
    expect(survivor).not.toBeNull();
  });

  it("ends personal credential access before deleting a workspace", async () => {
    const repository = new InMemoryWorkspaceRepository();
    const ended: Array<{ accountId: string; workspaceId: string; actorUserId?: string | null }> = [];
    const service = new WorkspaceService(repository, createAuditService(), undefined, {
      endWorkspace: async (input) => { ended.push(input); },
    });
    await service.create("account-1", "Keep");
    const target = await service.create("account-1", "Delete");

    await service.delete(target.id, "account-1", "owner-1");

    expect(ended).toEqual([{ accountId: "account-1", workspaceId: target.id, actorUserId: "owner-1" }]);
    await expect(repository.findByIdAndAccountId(target.id, "account-1")).resolves.toBeNull();
  });

  it("delegates workspace deletion to the transactional personal credential lifecycle", async () => {
    const repository = new InMemoryWorkspaceRepository();
    const deleted: Array<Record<string, unknown>> = [];
    const service = new WorkspaceService(repository, createAuditService(), undefined, undefined, {
      deleteWorkspace: async (input) => { deleted.push(input); return true; },
    });
    await service.create("account-1", "Keep");
    const target = await service.create("account-1", "Delete");

    await service.delete(target.id, "account-1", "owner-1");

    expect(deleted).toEqual([expect.objectContaining({
      accountId: "account-1",
      workspaceId: target.id,
      actorUserId: "owner-1",
      auditEvent: expect.objectContaining({ eventType: "workspace.deleted" }),
    })]);
    await expect(repository.findByIdAndAccountId(target.id, "account-1")).resolves.toEqual(target);
  });

  describe("data a vendor holds for the workspace's conversations", () => {
    const vendorHeldData = () => {
      const steps: string[] = [];
      const logger = { warn: vi.fn() };
      const eraser = {
        prepare: vi.fn(async (erasure: { scopes: ReadonlyArray<{ workspaceId: string }> }) => {
          const ids = erasure.scopes.map((scope) => scope.workspaceId).join(",");
          steps.push(`prepare:${ids}`);
          return { erase: async () => { steps.push(`erase:${ids}`); } };
        }),
      };
      return { steps, eraser, logger, vendorHeld: { eraser, logger } };
    };

    it("is read before the workspace is deleted and erased once it is gone", async () => {
      const repository = new InMemoryWorkspaceRepository();
      const { steps, eraser, vendorHeld } = vendorHeldData();
      const service = new WorkspaceService(repository, createAuditService(), undefined, {
        endWorkspace: async () => { steps.push("delete"); },
      }, undefined, vendorHeld);
      await service.create("account-1", "Keep");
      const target = await service.create("account-1", "Delete");

      await service.delete(target.id, "account-1", "owner-1");

      expect(steps).toEqual([`prepare:${target.id}`, "delete", `erase:${target.id}`]);
      expect(eraser.prepare).toHaveBeenCalledWith({
        account: { id: "account-1", deleted: false },
        scopes: [{ kind: "workspace", workspaceId: target.id }],
      });
    });

    it("is erased after a transactional deletion too, and never when the deletion is refused", async () => {
      const repository = new InMemoryWorkspaceRepository();
      const { steps, vendorHeld } = vendorHeldData();
      let deletes = true;
      const service = new WorkspaceService(repository, createAuditService(), undefined, undefined, {
        deleteWorkspace: async () => deletes,
      }, vendorHeld);
      await service.create("account-1", "Keep");
      const target = await service.create("account-1", "Delete");

      await service.delete(target.id, "account-1", "owner-1");
      expect(steps).toEqual([`prepare:${target.id}`, `erase:${target.id}`]);

      deletes = false;
      steps.length = 0;
      await expect(service.delete(target.id, "account-1", "owner-1")).rejects.toMatchObject({ statusCode: 404 });
      expect(steps).toEqual([`prepare:${target.id}`]);
    });

    it("never holds a deletion back when it cannot be read, and says so", async () => {
      const repository = new InMemoryWorkspaceRepository();
      const logger = { warn: vi.fn() };
      const service = new WorkspaceService(repository, createAuditService(), undefined, undefined, undefined, {
        eraser: { prepare: async () => { throw new Error("connection refused"); } },
        logger,
      });
      await service.create("account-1", "Keep");
      const target = await service.create("account-1", "Delete");

      await service.delete(target.id, "account-1", "owner-1");

      await expect(repository.findByIdAndAccountId(target.id, "account-1")).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith({ accountId: "account-1", errorClass: "Error" }, "Vendor-held data to erase could not be read");
    });

    it("is read as one erasure for every workspace of an account that is about to be deleted", async () => {
      const repository = new InMemoryWorkspaceRepository();
      const { steps, eraser, vendorHeld } = vendorHeldData();
      const service = new WorkspaceService(repository, createAuditService(), undefined, undefined, undefined, vendorHeld);
      const first = await service.create("account-1", "First");
      const second = await service.create("account-1", "Second");
      await service.create("account-2", "Elsewhere");

      const prepared = await service.prepareAccountDeletion("account-1");
      expect(eraser.prepare).toHaveBeenCalledTimes(1);
      expect(eraser.prepare).toHaveBeenCalledWith({
        account: { id: "account-1", deleted: true },
        scopes: expect.arrayContaining([{ kind: "workspace", workspaceId: first.id }, { kind: "workspace", workspaceId: second.id }]),
      });

      steps.length = 0;
      await prepared.afterDeletion();
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatch(/^erase:/);
    });

    it("says so when it cannot list the account's workspaces, and erases nothing", async () => {
      const repository = new InMemoryWorkspaceRepository();
      vi.spyOn(repository, "listByAccountId").mockRejectedValue(new Error("connection refused"));
      const { eraser, logger, vendorHeld } = vendorHeldData();
      const service = new WorkspaceService(repository, createAuditService(), undefined, undefined, undefined, vendorHeld);

      const prepared = await service.prepareAccountDeletion("account-1");
      await prepared.afterDeletion();

      expect(eraser.prepare).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { accountId: "account-1", errorClass: "Error" },
        "Workspaces whose vendor-held data to erase could not be read",
      );
    });
  });
});
