import { describe, expect, it } from "vitest";

import { WorkspaceSessionService } from "../../src/modules/auth/services/workspaceSessionService.js";
import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import { createAuditService, InMemoryWorkspaceRepository } from "../support/fakes.js";

describe("WorkspaceSessionService", () => {
  it("resolves an owned workspace for the authenticated account", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspaceService = new WorkspaceService(workspaceRepository, createAuditService());
    const workspaceSessionService = new WorkspaceSessionService(workspaceService);
    const workspace = await workspaceRepository.create("account-1", "Default");

    await expect(
      workspaceSessionService.resolve({
        accountId: "account-1",
        workspaceId: workspace.id,
      }),
    ).resolves.toEqual({
      accountId: "account-1",
      workspaceId: workspace.id,
    });
  });

  it("rejects missing workspace selection and unowned workspaces", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspaceService = new WorkspaceService(workspaceRepository, createAuditService());
    const workspaceSessionService = new WorkspaceSessionService(workspaceService);
    const workspace = await workspaceRepository.create("account-1", "Default");

    await expect(
      workspaceSessionService.resolve({
        accountId: "account-1",
        workspaceId: undefined,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "bad_request",
    });

    await expect(
      workspaceSessionService.resolve({
        accountId: "account-2",
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});
