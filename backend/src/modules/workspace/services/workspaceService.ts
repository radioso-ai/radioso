import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AuditService } from "../../audit/services/auditService.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";

export class WorkspaceService {
  constructor(
    private readonly workspaceRepository: WorkspaceRepositoryPort,
    private readonly auditService: AuditService,
  ) {}

  async create(accountId: string, name: string): Promise<WorkspaceRecord> {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw badRequest("Workspace name must be between 1 and 100 characters");
    }

    return this.workspaceRepository.create(accountId, trimmedName);
  }

  async createDefault(accountId: string): Promise<WorkspaceRecord> {
    return this.workspaceRepository.create(accountId, "Default");
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
