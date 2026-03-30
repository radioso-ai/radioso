import type { WorkspaceService } from "../../workspace/services/workspaceService.js";
import { badRequest } from "../../../shared/domain/errors.js";

export class WorkspaceSessionService {
  constructor(private readonly workspaceService: WorkspaceService) {}

  async resolve(input: {
    accountId: string;
    workspaceId: string | null | undefined;
  }): Promise<{ accountId: string; workspaceId: string }> {
    const workspaceId = input.workspaceId?.trim();
    if (!workspaceId) {
      throw badRequest("Workspace selection is required");
    }

    const workspace = await this.workspaceService.validateOwnership(workspaceId, input.accountId);
    return {
      accountId: input.accountId,
      workspaceId: workspace.id,
    };
  }
}
