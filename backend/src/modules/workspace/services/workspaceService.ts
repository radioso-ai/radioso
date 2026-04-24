import type { AccountMembershipRepositoryPort } from "../../../db/repositories/accountMembershipRepository.js";
import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AuditService } from "../../audit/services/auditService.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { createWorkspacePublicRouteKey } from "../domain/publicRouteKey.js";

export class WorkspaceService {
  constructor(
    private readonly workspaceRepository: WorkspaceRepositoryPort,
    private readonly auditService: AuditService,
    private readonly accountMembershipRepository?: AccountMembershipRepositoryPort,
  ) {}

  private async createWorkspaceWithPublicRouteKey(accountId: string, name: string): Promise<WorkspaceRecord> {
    let attempts = 0;

    while (attempts < 5) {
      try {
        return await this.workspaceRepository.create(accountId, name, createWorkspacePublicRouteKey(name));
      } catch (error) {
        attempts += 1;
        if (!(error instanceof Error) || !/public_route_key/i.test(error.message) || attempts >= 5) {
          throw error;
        }
      }
    }

    throw new Error("Failed to generate unique workspace route key");
  }

  async create(accountId: string, name: string): Promise<WorkspaceRecord> {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw badRequest("Workspace name must be between 1 and 100 characters");
    }

    return this.createWorkspaceWithPublicRouteKey(accountId, trimmedName);
  }

  async createDefault(accountId: string): Promise<WorkspaceRecord> {
    const existing = await this.workspaceRepository.listByAccountId(accountId);
    if (existing.length > 0) {
      return existing.find((workspace) => workspace.name === "Default") ?? existing[0];
    }

    return this.createWorkspaceWithPublicRouteKey(accountId, "Default");
  }

  async resolveLoginWorkspace(accountId: string, preferredWorkspaceId?: string | null): Promise<WorkspaceRecord> {
    const existing = await this.workspaceRepository.listByAccountId(accountId);
    if (existing.length === 0) {
      return this.createWorkspaceWithPublicRouteKey(accountId, "Default");
    }

    if (preferredWorkspaceId) {
      const preferred = existing.find((workspace) => workspace.id === preferredWorkspaceId);
      if (preferred) {
        return preferred;
      }
    }

    return existing.find((workspace) => workspace.name === "Default") ?? existing.at(-1)!;
  }

  async listForAccount(accountId: string): Promise<WorkspaceRecord[]> {
    return this.workspaceRepository.listByAccountId(accountId);
  }

  async validateOwnership(workspaceId: string, accountId: string): Promise<WorkspaceRecord> {
    const workspace = await this.workspaceRepository.findByIdAndAccountId(workspaceId, accountId);
    if (!workspace) {
      throw notFound("Workspace not found");
    }

    return workspace;
  }

  async findByPublicRouteKey(publicRouteKey: string): Promise<WorkspaceRecord | null> {
    return this.workspaceRepository.findByPublicRouteKey(publicRouteKey.trim());
  }

  async resolveAccessibleByPublicRouteKey(userId: string, publicRouteKey: string): Promise<WorkspaceRecord> {
    const workspace = await this.findByPublicRouteKey(publicRouteKey);
    if (!workspace || !this.accountMembershipRepository) {
      throw notFound("Workspace not found");
    }

    const membership = await this.accountMembershipRepository.findActiveByAccountAndUser(workspace.accountId, userId);
    if (!membership) {
      throw notFound("Workspace not found");
    }

    return workspace;
  }

  async rename(workspaceId: string, accountId: string, newName: string): Promise<WorkspaceRecord> {
    const workspace = await this.validateOwnership(workspaceId, accountId);
    const trimmedName = newName.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw badRequest("Workspace name must be between 1 and 100 characters");
    }

    const updated = await this.workspaceRepository.updateName(workspaceId, trimmedName);

    await this.auditService.record({
      accountId,
      workspaceId,
      eventType: "workspace.renamed",
      eventStatus: "success",
      metadata: { previousName: workspace.name, newName: trimmedName },
    });

    return updated;
  }

  async delete(workspaceId: string, accountId: string): Promise<void> {
    const workspace = await this.validateOwnership(workspaceId, accountId);

    const count = await this.workspaceRepository.countByAccountId(accountId);
    if (count <= 1) {
      throw badRequest("Cannot delete the last workspace");
    }

    await this.auditService.record({
      accountId,
      workspaceId: null,
      eventType: "workspace.deleted",
      eventStatus: "success",
      metadata: { deletedWorkspaceId: workspaceId, deletedWorkspaceName: workspace.name },
    });

    await this.workspaceRepository.deleteById(workspaceId);
  }
}
