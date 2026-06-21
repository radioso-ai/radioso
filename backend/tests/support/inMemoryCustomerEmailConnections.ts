import {
  EMAIL_INTEGRATION_PROVIDERS,
  type CreateCustomerEmailConnectionInput,
  type CustomerEmailConnectionRecord,
  type CustomerEmailConnectionRepositoryPort,
  type UpdateCustomerEmailConnectionInput,
} from "../../src/db/repositories/customerEmailConnectionRepository.js";
import { InMemoryIntegrationConnectionRepository } from "./inMemoryIntegrationConnections.js";
import type { IntegrationConnectionRecord } from "../../src/modules/integrationConnections/public.js";

const clone = (record: CustomerEmailConnectionRecord): CustomerEmailConnectionRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
  lastHealthCheckedAt: record.lastHealthCheckedAt ? new Date(record.lastHealthCheckedAt) : null,
});

const customerEmailProviderToIntegrationProvider = (provider: string): string => {
  if (provider === "google_mail") return "customer_email_google";
  if (provider === "microsoft_graph_mail") return "customer_email_microsoft";
  return provider;
};

const integrationProviderToCustomerEmailProvider = (provider: string): string => {
  if (provider === "customer_email_google") return "google_mail";
  if (provider === "customer_email_microsoft") return "microsoft_graph_mail";
  return provider;
};

const configString = (config: Record<string, unknown>, key: string): string | null => {
  const value = config[key];
  return typeof value === "string" ? value : null;
};

const isCustomerEmailProvider = (provider: string): boolean =>
  (EMAIL_INTEGRATION_PROVIDERS as readonly string[]).includes(provider);

const mapFromIntegration = (record: IntegrationConnectionRecord): CustomerEmailConnectionRecord => ({
  id: record.id,
  workspaceId: record.workspaceId,
  oauthConnectionId: record.oauthConnectionId,
  provider: integrationProviderToCustomerEmailProvider(record.provider),
  displayName: record.displayName,
  senderEmail: configString(record.config, "senderEmail") ?? "",
  senderName: configString(record.config, "senderName"),
  replyToEmail: configString(record.config, "replyToEmail"),
  status: record.status,
  lastHealthStatus: record.lastHealthStatus,
  lastHealthCheckedAt: record.lastHealthCheckedAt,
  lastErrorCode: record.lastErrorCode,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export class InMemoryCustomerEmailConnectionRepository implements CustomerEmailConnectionRepositoryPort {
  private readonly integrationConnections = new InMemoryIntegrationConnectionRepository();
  private referenceChecker: (connectionId: string) => number | Promise<number> = () => 0;

  setReferenceChecker(checker: (connectionId: string) => number | Promise<number>): void {
    this.referenceChecker = checker;
  }

  async create(input: CreateCustomerEmailConnectionInput): Promise<CustomerEmailConnectionRecord> {
    const record = await this.integrationConnections.create({
      workspaceId: input.workspaceId,
      oauthConnectionId: input.oauthConnectionId,
      provider: customerEmailProviderToIntegrationProvider(input.provider),
      displayName: input.displayName,
      status: input.status ?? "authorized",
      lastHealthStatus: input.lastHealthStatus ?? null,
      lastHealthCheckedAt: input.lastHealthCheckedAt ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      config: {
        senderEmail: input.senderEmail,
        senderName: input.senderName ?? null,
        replyToEmail: input.replyToEmail ?? null,
      },
    });
    return clone(mapFromIntegration(record));
  }

  async findById(workspaceId: string, id: string): Promise<CustomerEmailConnectionRecord | null> {
    const record = await this.integrationConnections.findById(workspaceId, id, EMAIL_INTEGRATION_PROVIDERS);
    return record ? clone(mapFromIntegration(record)) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<CustomerEmailConnectionRecord[]> {
    const records = await this.integrationConnections.listByWorkspace(workspaceId);
    return records
      .filter((record) => isCustomerEmailProvider(record.provider))
      .map((record) => clone(mapFromIntegration(record)));
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateCustomerEmailConnectionInput,
  ): Promise<CustomerEmailConnectionRecord | null> {
    const config: Record<string, unknown> = {};
    if (input.senderEmail !== undefined) config.senderEmail = input.senderEmail;
    if (input.senderName !== undefined) config.senderName = input.senderName;
    if (input.replyToEmail !== undefined) config.replyToEmail = input.replyToEmail;
    const record = await this.integrationConnections.update(
      workspaceId,
      id,
      {
        ...("displayName" in input ? { displayName: input.displayName } : {}),
        ...("status" in input ? { status: input.status } : {}),
        ...("lastHealthStatus" in input ? { lastHealthStatus: input.lastHealthStatus } : {}),
        ...("lastHealthCheckedAt" in input ? { lastHealthCheckedAt: input.lastHealthCheckedAt } : {}),
        ...("lastErrorCode" in input ? { lastErrorCode: input.lastErrorCode } : {}),
        ...(Object.keys(config).length > 0 ? { config } : {}),
      },
      EMAIL_INTEGRATION_PROVIDERS,
    );
    return record ? clone(mapFromIntegration(record)) : null;
  }

  async countSkillReferences(workspaceId: string, id: string): Promise<number> {
    const record = await this.integrationConnections.findById(workspaceId, id, EMAIL_INTEGRATION_PROVIDERS);
    if (!record) {
      return 0;
    }
    return this.referenceChecker(id);
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    return this.integrationConnections.remove(workspaceId, id, EMAIL_INTEGRATION_PROVIDERS);
  }
}
