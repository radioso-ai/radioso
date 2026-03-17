import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import { badRequest, forbidden, notFound } from "../../../shared/domain/errors.js";

export class WorkspaceService {
  constructor(private readonly workspaceRepository: WorkspaceRepositoryPort) {}

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
      throw forbidden("Workspace not found or not owned by this account");
    }

    return workspace;
  }

  async delete(workspaceId: string, accountId: string): Promise<void> {
    await this.validateOwnership(workspaceId, accountId);

    const count = await this.workspaceRepository.countByAccountId(accountId);
    if (count <= 1) {
      throw badRequest("Cannot delete the last workspace");
    }

    await this.workspaceRepository.deleteById(workspaceId);
  }
}
