import { describe, expect, it } from "vitest";

import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import {
  InMemoryAccountMembershipRepository,
  InMemoryWorkspaceRepository,
  createAuditService,
} from "../support/fakes.js";

describe("workspace service", () => {
  it("creates workspaces with a readable public route key", async () => {
    const service = new WorkspaceService(new InMemoryWorkspaceRepository(), createAuditService());

    const workspace = await service.create("account-1", "Customer Support");

    expect(workspace.publicRouteKey).toMatch(/^customer-support-[a-z0-9]{6}$/);
  });

  it("caps public route keys so long workspace names still produce valid URLs", async () => {
    const service = new WorkspaceService(new InMemoryWorkspaceRepository(), createAuditService());

    const workspace = await service.create(
      "account-1",
      "This workspace name is intentionally much longer than the canonical route should expose",
    );

    expect(workspace.publicRouteKey).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{6}$/);
    expect(workspace.publicRouteKey.length).toBeLessThanOrEqual(31);
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
});
