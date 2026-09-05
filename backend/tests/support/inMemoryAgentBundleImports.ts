import { randomUUID } from "node:crypto";

import type {
  AgentBundleImportFailureCode,
  AgentBundleImportRecord,
  AgentBundleImportRepositoryPort,
  AgentBundleImportResult,
} from "../../src/modules/agentBundle/public.js";

export class InMemoryAgentBundleImportRepository implements AgentBundleImportRepositoryPort {
  private readonly records = new Map<string, AgentBundleImportRecord>();

  async createOrGet(input: { workspaceId: string; actorAccountId: string | null; idempotencyKey: string | null }) {
    const existing = [...this.records.values()].find((record) =>
      record.workspaceId === input.workspaceId
      && record.idempotencyKey === input.idempotencyKey
      && ["queued", "applying", "applied"].includes(record.state));
    if (existing) return { status: "existing" as const, job: existing };
    const now = new Date();
    const job: AgentBundleImportRecord = {
      id: randomUUID(), workspaceId: input.workspaceId, actorAccountId: input.actorAccountId,
      idempotencyKey: input.idempotencyKey, state: "queued", agentId: null, unresolved: [], failureCode: null,
      createdAt: now, updatedAt: now, appliedAt: null, compensatedAt: null,
    };
    this.records.set(job.id, job);
    return { status: "created" as const, job };
  }

  async findById(workspaceId: string, importId: string) {
    const job = this.records.get(importId);
    return job?.workspaceId === workspaceId ? job : null;
  }

  async markApplying(importId: string): Promise<void> { this.update(importId, { state: "applying" }); }
  async setCreatedAgent(importId: string, agentId: string): Promise<void> { this.update(importId, { agentId }); }
  async markApplied(importId: string, result: AgentBundleImportResult): Promise<void> {
    this.update(importId, { state: "applied", unresolved: result.unresolved, appliedAt: new Date(), failureCode: null });
  }
  async markFailed(importId: string, failureCode: AgentBundleImportFailureCode, options: { terminal: boolean }): Promise<void> {
    this.update(importId, { state: options.terminal ? "failed" : "applying", failureCode });
  }
  async claimStaleApplying(): Promise<AgentBundleImportRecord[]> { return []; }
  async markCompensated(importId: string): Promise<void> { this.update(importId, { state: "compensated", compensatedAt: new Date() }); }

  private update(importId: string, changes: Partial<AgentBundleImportRecord>): void {
    const current = this.records.get(importId);
    if (!current) return;
    this.records.set(importId, { ...current, ...changes, updatedAt: new Date() });
  }
}
