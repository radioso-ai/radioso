import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";

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
      throw notFound("Workspace not found");
    }

    return workspace;
  }

}
