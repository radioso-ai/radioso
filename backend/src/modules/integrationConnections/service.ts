import { notFound } from "../../shared/domain/errors.js";
import type {
  IntegrationConnectionRecord,
  IntegrationConnectionStatus,
  UpdateIntegrationConnectionInput,
} from "./domain.js";
import type { IntegrationConnectionRepositoryPort } from "./repository.js";
import { assertIntegrationConnectionStatusTransition } from "./stateMachine.js";

export interface IntegrationConnectionServiceOptions {
  repository: IntegrationConnectionRepositoryPort;
}

export class IntegrationConnectionService {
  constructor(private readonly options: IntegrationConnectionServiceOptions) {}

  async get(workspaceId: string, connectionId: string): Promise<IntegrationConnectionRecord> {
    const record = await this.options.repository.findById(workspaceId, connectionId);
    if (!record) {
      throw notFound("Integration connection not found");
    }
    return record;
  }

  async update(
    workspaceId: string,
    connectionId: string,
    input: UpdateIntegrationConnectionInput,
  ): Promise<IntegrationConnectionRecord> {
    if (input.status !== undefined) {
      const existing = await this.get(workspaceId, connectionId);
      assertIntegrationConnectionStatusTransition(existing.status, input.status);
    }
    const updated = await this.options.repository.update(workspaceId, connectionId, input);
    if (!updated) {
      throw notFound("Integration connection not found");
    }
    return updated;
  }

  async setStatus(
    workspaceId: string,
    connectionId: string,
    status: IntegrationConnectionStatus,
    details: Omit<UpdateIntegrationConnectionInput, "status" | "config" | "displayName"> = {},
  ): Promise<IntegrationConnectionRecord> {
    return this.update(workspaceId, connectionId, { ...details, status });
  }
}
