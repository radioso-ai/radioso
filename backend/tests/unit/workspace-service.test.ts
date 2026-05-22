import { describe, expect, it } from "vitest";

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
});
