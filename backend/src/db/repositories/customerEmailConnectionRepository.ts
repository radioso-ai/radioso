import { randomUUID } from "node:crypto";

import type {
  CustomerEmailConnectionStatus,
  CustomerEmailHealthStatus,
} from "../../modules/customerEmail/domain.js";
import { currentTimestamp, tableExists } from "../../shared/infra/kysely/sqlHelpers.js";
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

interface CustomerEmailConnectionRow {
  id: string;
  workspace_id: string;
  oauth_connection_id: string;
  provider: string;
  display_name: string;
  sender_email: string;
  sender_name: string | null;
  reply_to_email: string | null;
  status: CustomerEmailConnectionStatus;
  last_health_status: CustomerEmailHealthStatus | null;
  last_health_checked_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

const customerEmailColumns = [
  "id",
  "workspace_id",
  "oauth_connection_id",
  "provider",
  "display_name",
  "sender_email",
  "sender_name",
  "reply_to_email",
  "status",
  "last_health_status",
  "last_health_checked_at",
  "last_error_code",
  "created_at",
  "updated_at",
] as const;

const mapRecord = (row: CustomerEmailConnectionRow): CustomerEmailConnectionRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  oauthConnectionId: row.oauth_connection_id,
  provider: row.provider,
  displayName: row.display_name,
  senderEmail: row.sender_email,
  senderName: row.sender_name,
  replyToEmail: row.reply_to_email,
  status: row.status,
  lastHealthStatus: row.last_health_status,
  lastHealthCheckedAt: row.last_health_checked_at ? new Date(row.last_health_checked_at) : null,
  lastErrorCode: row.last_error_code,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
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
  constructor(private readonly db: Db) {}

  async create(input: CreateCustomerEmailConnectionInput): Promise<CustomerEmailConnectionRecord> {
    const row = await this.db
      .insertInto("customer_email_connections")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        oauth_connection_id: input.oauthConnectionId,
        provider: input.provider,
        display_name: input.displayName,
        sender_email: input.senderEmail,
        sender_name: input.senderName ?? null,
        reply_to_email: input.replyToEmail ?? null,
        status: input.status ?? "authorized",
        last_health_status: input.lastHealthStatus ?? null,
        last_health_checked_at: input.lastHealthCheckedAt ?? null,
        last_error_code: input.lastErrorCode ?? null,
      })
      .returning(customerEmailColumns)
      .executeTakeFirstOrThrow();
    return mapRecord(row as CustomerEmailConnectionRow);
  }

  async findById(workspaceId: string, id: string): Promise<CustomerEmailConnectionRecord | null> {
    const row = await this.db
      .selectFrom("customer_email_connections")
      .select(customerEmailColumns)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row as CustomerEmailConnectionRow) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<CustomerEmailConnectionRecord[]> {
    const rows = await this.db
      .selectFrom("customer_email_connections")
      .select(customerEmailColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => mapRecord(row as CustomerEmailConnectionRow));
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateCustomerEmailConnectionInput,
  ): Promise<CustomerEmailConnectionRecord | null> {
    // Property presence is the signal; Kysely merges chained .set() calls (each typed).
    let query = this.db.updateTable("customer_email_connections");
    let hasAssignment = false;

    if ("displayName" in input) { query = query.set({ display_name: input.displayName! }); hasAssignment = true; }
    if ("senderEmail" in input) { query = query.set({ sender_email: input.senderEmail! }); hasAssignment = true; }
    if ("senderName" in input) { query = query.set({ sender_name: input.senderName ?? null }); hasAssignment = true; }
    if ("replyToEmail" in input) { query = query.set({ reply_to_email: input.replyToEmail ?? null }); hasAssignment = true; }
    if ("status" in input) { query = query.set({ status: input.status! }); hasAssignment = true; }
    if ("lastHealthStatus" in input) { query = query.set({ last_health_status: input.lastHealthStatus ?? null }); hasAssignment = true; }
    if ("lastHealthCheckedAt" in input) { query = query.set({ last_health_checked_at: input.lastHealthCheckedAt ?? null }); hasAssignment = true; }
    if ("lastErrorCode" in input) { query = query.set({ last_error_code: input.lastErrorCode ?? null }); hasAssignment = true; }

    if (!hasAssignment) {
      return this.findById(workspaceId, id);
    }

    const row = await query
      .set({ updated_at: currentTimestamp() })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .returning(customerEmailColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as CustomerEmailConnectionRow) : null;
  }

  async countSkillReferences(workspaceId: string, id: string): Promise<number> {
    // Skill tables are absent in a few focused repository schemas, so keep this
    // guard tolerant while enforcing references through the shared skill spine.
    if (!(await tableExists(this.db, "agent_skills"))) {
      return 0;
    }
    const row = await this.db
      .selectFrom("agent_skills")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("kind", "=", "customer_email")
      .where("workspace_id", "=", workspaceId)
      .where("target_type", "=", "customer_email_connection")
      .where("target_id", "=", id)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("customer_email_connections")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
