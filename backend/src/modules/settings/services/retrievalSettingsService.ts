import {
  defaultRetrievalSettings,
  type RetrievalSettingsInput,
  type RetrievalSettingsRecord,
  validateRetrievalSettings,
} from "../domain/retrievalSettings.js";
import type { AuditService } from "../../audit/services/auditService.js";

export interface RetrievalSettingsRepositoryPort {
  findByAccountId(accountId: string): Promise<RetrievalSettingsRecord | null>;
  upsert(accountId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord>;
}

export class RetrievalSettingsService {
  constructor(
    private readonly repository: RetrievalSettingsRepositoryPort,
    private readonly auditService: AuditService,
  ) {}

  async getForAccount(accountId: string): Promise<RetrievalSettingsRecord> {
    const existing = await this.repository.findByAccountId(accountId);

    if (existing) {
      return existing;
    }

    const defaults = defaultRetrievalSettings(accountId);
    return this.repository.upsert(accountId, defaults);
  }

  async updateForAccount(accountId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord> {
    try {
      const settings = await this.repository.upsert(accountId, validateRetrievalSettings(input));
      await this.auditService.record({
        accountId,
        eventType: "settings.update",
        eventStatus: "success",
      });
      return settings;
    } catch (error) {
      await this.auditService.record({
        accountId,
        eventType: "settings.update",
        eventStatus: "failure",
      });
      throw error;
    }
  }
}
