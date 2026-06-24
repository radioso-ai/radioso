import { randomUUID } from "node:crypto";

import type {
  SlackBindingRepositoryPort,
  SlackChannelBindingRecord,
  SlackInstallationRecord,
  SlackInstallationRepositoryPort,
  UpsertSlackBindingInput,
  UpsertSlackInstallationInput,
} from "../../src/modules/slack/install/slackInstallationService.js";

const cloneInstallation = (record: SlackInstallationRecord): SlackInstallationRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

const cloneBinding = (record: SlackChannelBindingRecord): SlackChannelBindingRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

export class InMemorySlackInstallationRepository implements SlackInstallationRepositoryPort {
  readonly rows = new Map<string, SlackInstallationRecord>();

  async findById(installationId: string): Promise<SlackInstallationRecord | null> {
    const record = this.rows.get(installationId);
    return record ? cloneInstallation(record) : null;
  }

  async findByTeamId(teamId: string): Promise<SlackInstallationRecord | null> {
    const record = [...this.rows.values()].find((row) => row.teamId === teamId);
    return record ? cloneInstallation(record) : null;
  }

  async findByWorkspaceId(workspaceId: string): Promise<SlackInstallationRecord | null> {
    const record = [...this.rows.values()].find((row) => row.workspaceId === workspaceId);
    return record ? cloneInstallation(record) : null;
  }

  async upsert(input: UpsertSlackInstallationInput): Promise<SlackInstallationRecord> {
    const existing = [...this.rows.values()].find((row) => row.teamId === input.teamId);
    const now = new Date();
    const record: SlackInstallationRecord = {
      id: existing?.id ?? randomUUID(),
      connectionId: input.connectionId,
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      teamName: input.teamName ?? null,
      botUserId: input.botUserId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return cloneInstallation(record);
  }

  async removeByWorkspaceId(workspaceId: string): Promise<boolean> {
    const record = [...this.rows.values()].find((row) => row.workspaceId === workspaceId);
    if (!record) {
      return false;
    }
    this.rows.delete(record.id);
    return true;
  }
}

export class InMemorySlackBindingRepository implements SlackBindingRepositoryPort {
  readonly rows = new Map<string, SlackChannelBindingRecord>();

  async findByInstallationId(installationId: string): Promise<SlackChannelBindingRecord | null> {
    const record = [...this.rows.values()].find((row) => row.installationId === installationId);
    return record ? cloneBinding(record) : null;
  }

  async upsert(input: UpsertSlackBindingInput): Promise<SlackChannelBindingRecord> {
    const existing = [...this.rows.values()].find((row) => row.installationId === input.installationId);
    const now = new Date();
    const record: SlackChannelBindingRecord = {
      id: existing?.id ?? randomUUID(),
      installationId: input.installationId,
      workspaceId: input.workspaceId,
      answeringAgentId: input.answeringAgentId,
      escalationChannelId: input.escalationChannelId ?? null,
      gapEscalationEnabled: input.gapEscalationEnabled ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return cloneBinding(record);
  }

  async removeByInstallationId(installationId: string): Promise<boolean> {
    const record = [...this.rows.values()].find((row) => row.installationId === installationId);
    if (!record) {
      return false;
    }
    this.rows.delete(record.id);
    return true;
  }
}
