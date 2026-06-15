import { randomUUID } from "node:crypto";

import type {
  CreateCustomerEmailConnectionInput,
  CustomerEmailConnectionRecord,
  CustomerEmailConnectionRepositoryPort,
  UpdateCustomerEmailConnectionInput,
} from "../../src/db/repositories/customerEmailConnectionRepository.js";

const clone = (record: CustomerEmailConnectionRecord): CustomerEmailConnectionRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
  lastHealthCheckedAt: record.lastHealthCheckedAt ? new Date(record.lastHealthCheckedAt) : null,
});

export class InMemoryCustomerEmailConnectionRepository implements CustomerEmailConnectionRepositoryPort {
  private readonly rows = new Map<string, CustomerEmailConnectionRecord>();
  private referenceChecker: (connectionId: string) => number | Promise<number> = () => 0;

  setReferenceChecker(checker: (connectionId: string) => number | Promise<number>): void {
    this.referenceChecker = checker;
  }

  async create(input: CreateCustomerEmailConnectionInput): Promise<CustomerEmailConnectionRecord> {
    const now = new Date();
    const record: CustomerEmailConnectionRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      oauthConnectionId: input.oauthConnectionId,
      provider: input.provider,
      displayName: input.displayName,
      senderEmail: input.senderEmail,
      senderName: input.senderName ?? null,
      replyToEmail: input.replyToEmail ?? null,
      status: input.status ?? "authorized",
      lastHealthStatus: input.lastHealthStatus ?? null,
      lastHealthCheckedAt: input.lastHealthCheckedAt ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return clone(record);
  }

  async findById(workspaceId: string, id: string): Promise<CustomerEmailConnectionRecord | null> {
    const record = this.rows.get(id);
    return record && record.workspaceId === workspaceId ? clone(record) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<CustomerEmailConnectionRecord[]> {
    return [...this.rows.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .map(clone);
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateCustomerEmailConnectionInput,
  ): Promise<CustomerEmailConnectionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return null;
    }
    if (input.displayName !== undefined) record.displayName = input.displayName;
    if (input.senderEmail !== undefined) record.senderEmail = input.senderEmail;
    if (input.senderName !== undefined) record.senderName = input.senderName;
    if (input.replyToEmail !== undefined) record.replyToEmail = input.replyToEmail;
    if (input.status !== undefined) record.status = input.status;
    if (input.lastHealthStatus !== undefined) record.lastHealthStatus = input.lastHealthStatus;
    if (input.lastHealthCheckedAt !== undefined) record.lastHealthCheckedAt = input.lastHealthCheckedAt;
    if (input.lastErrorCode !== undefined) record.lastErrorCode = input.lastErrorCode;
    record.updatedAt = new Date();
    return clone(record);
  }

  async countSkillReferences(workspaceId: string, id: string): Promise<number> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return 0;
    }
    return this.referenceChecker(id);
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return false;
    }
    this.rows.delete(id);
    return true;
  }
}
