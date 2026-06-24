import type {
  CustomerEmailConnectionStatus,
  CustomerEmailHealthStatus,
} from "../../modules/customerEmail/domain.js";
import {
  IntegrationConnectionRepository,
  type IntegrationConnectionRecord,
} from "../../modules/integrationConnections/public.js";
import { castText, tableExists } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface CustomerEmailConnectionRecord {
  id: string;
  workspaceId: string;
  oauthConnectionId: string;
  provider: string;
  displayName: string;
  senderEmail: string;
  senderName: string | null;
  replyToEmail: string | null;
  status: CustomerEmailConnectionStatus;
  lastHealthStatus: CustomerEmailHealthStatus | null;
  lastHealthCheckedAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCustomerEmailConnectionInput {
  workspaceId: string;
  oauthConnectionId: string;
  provider: string;
  displayName: string;
  senderEmail: string;
  senderName?: string | null;
  replyToEmail?: string | null;
  status?: CustomerEmailConnectionStatus;
  lastHealthStatus?: CustomerEmailHealthStatus | null;
  lastHealthCheckedAt?: Date | null;
  lastErrorCode?: string | null;
}

export interface UpdateCustomerEmailConnectionInput {
  displayName?: string;
  senderEmail?: string;
  senderName?: string | null;
  replyToEmail?: string | null;
  status?: CustomerEmailConnectionStatus;
  lastHealthStatus?: CustomerEmailHealthStatus | null;
  lastHealthCheckedAt?: Date | null;
  lastErrorCode?: string | null;
}

// The integration_connections spine is shared across providers (e.g. Slack).
// Customer-email owns ONLY these provider rows; every id-based read/mutate/delete
// path scopes to this set so the email API cannot touch another provider's
// connection by id. `create()` only ever stores these values.
export const EMAIL_INTEGRATION_PROVIDERS = ["customer_email_google", "customer_email_microsoft"] as const;

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

const isCustomerEmailIntegrationProvider = (provider: string): boolean =>
  (EMAIL_INTEGRATION_PROVIDERS as readonly string[]).includes(provider);

const configString = (config: Record<string, unknown>, key: string): string | null => {
  const value = config[key];
  return typeof value === "string" ? value : null;
};

const mapRecord = (record: IntegrationConnectionRecord): CustomerEmailConnectionRecord => ({
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

export interface CustomerEmailConnectionRepositoryPort {
  create(input: CreateCustomerEmailConnectionInput): Promise<CustomerEmailConnectionRecord>;
  findById(workspaceId: string, id: string): Promise<CustomerEmailConnectionRecord | null>;
  listByWorkspace(workspaceId: string): Promise<CustomerEmailConnectionRecord[]>;
  update(
    workspaceId: string,
    id: string,
    input: UpdateCustomerEmailConnectionInput,
  ): Promise<CustomerEmailConnectionRecord | null>;
  countSkillReferences(workspaceId: string, id: string): Promise<number>;
  remove(workspaceId: string, id: string): Promise<boolean>;
}

export class CustomerEmailConnectionRepository implements CustomerEmailConnectionRepositoryPort {
  private readonly integrationConnections: IntegrationConnectionRepository;
  private readonly db: Db;

  constructor(db: Db) {
    this.integrationConnections = new IntegrationConnectionRepository(db);
    this.db = db;
  }

  async create(input: CreateCustomerEmailConnectionInput): Promise<CustomerEmailConnectionRecord> {
    const created = await this.integrationConnections.create({
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
    return mapRecord(created);
  }

  async findById(workspaceId: string, id: string): Promise<CustomerEmailConnectionRecord | null> {
    const record = await this.integrationConnections.findById(
      workspaceId,
      id,
      EMAIL_INTEGRATION_PROVIDERS,
    );
    return record ? mapRecord(record) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<CustomerEmailConnectionRecord[]> {
    const records = await this.integrationConnections.listByWorkspace(workspaceId);
    return records
      .filter((record) => isCustomerEmailIntegrationProvider(record.provider))
      .map(mapRecord);
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateCustomerEmailConnectionInput,
  ): Promise<CustomerEmailConnectionRecord | null> {
    const config: Record<string, unknown> = {};
    if ("senderEmail" in input) config.senderEmail = input.senderEmail;
    if ("senderName" in input) config.senderName = input.senderName ?? null;
    if ("replyToEmail" in input) config.replyToEmail = input.replyToEmail ?? null;

    const updated = await this.integrationConnections.update(
      workspaceId,
      id,
      {
        ...("displayName" in input ? { displayName: input.displayName } : {}),
        ...("status" in input ? { status: input.status } : {}),
        ...("lastHealthStatus" in input ? { lastHealthStatus: input.lastHealthStatus ?? null } : {}),
        ...("lastHealthCheckedAt" in input ? { lastHealthCheckedAt: input.lastHealthCheckedAt ?? null } : {}),
        ...("lastErrorCode" in input ? { lastErrorCode: input.lastErrorCode ?? null } : {}),
        ...(Object.keys(config).length > 0 ? { config } : {}),
      },
      EMAIL_INTEGRATION_PROVIDERS,
    );
    return updated ? mapRecord(updated) : null;
  }

  async countSkillReferences(workspaceId: string, id: string): Promise<number> {
    // Skill tables are absent in a few focused repository schemas, so keep this
    // guard tolerant while enforcing references through the shared skill spine.
    if (!(await tableExists(this.db, "agent_skills"))) {
      return 0;
    }
    const row = await this.db
      .selectFrom("agent_skills as s")
      .select((eb) => castText(eb.fn.countAll()).as("count"))
      .where("s.kind", "=", "customer_email")
      .where("s.workspace_id", "=", workspaceId)
      .where("s.target_type", "=", "customer_email_connection")
      .where("s.target_id", "=", id)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    return this.integrationConnections.remove(workspaceId, id, EMAIL_INTEGRATION_PROVIDERS);
  }
}
