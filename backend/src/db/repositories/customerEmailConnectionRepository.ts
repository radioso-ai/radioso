import { randomUUID } from "node:crypto";

import type {
  CustomerEmailConnectionStatus,
  CustomerEmailHealthStatus,
} from "../../modules/customerEmail/domain.js";
import type { Database } from "../../shared/infra/database.js";

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

const COLUMNS =
  "id, workspace_id, oauth_connection_id, provider, display_name, sender_email, sender_name, reply_to_email, status, last_health_status, last_health_checked_at, last_error_code, created_at, updated_at";

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
  constructor(private readonly database: Database) {}

  async create(input: CreateCustomerEmailConnectionInput): Promise<CustomerEmailConnectionRecord> {
    const [row] = await this.database.query<CustomerEmailConnectionRow>(
      `INSERT INTO customer_email_connections
         (id, workspace_id, oauth_connection_id, provider, display_name, sender_email, sender_name,
          reply_to_email, status, last_health_status, last_health_checked_at, last_error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.workspaceId,
        input.oauthConnectionId,
        input.provider,
        input.displayName,
        input.senderEmail,
        input.senderName ?? null,
        input.replyToEmail ?? null,
        input.status ?? "authorized",
        input.lastHealthStatus ?? null,
        input.lastHealthCheckedAt ?? null,
        input.lastErrorCode ?? null,
      ],
    );
    return mapRecord(row);
  }

  async findById(workspaceId: string, id: string): Promise<CustomerEmailConnectionRecord | null> {
    const [row] = await this.database.query<CustomerEmailConnectionRow>(
      `SELECT ${COLUMNS} FROM customer_email_connections WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id],
    );
    return row ? mapRecord(row) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<CustomerEmailConnectionRecord[]> {
    const rows = await this.database.query<CustomerEmailConnectionRow>(
      `SELECT ${COLUMNS}
       FROM customer_email_connections
       WHERE workspace_id = $1
       ORDER BY created_at ASC`,
      [workspaceId],
    );
    return rows.map(mapRecord);
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateCustomerEmailConnectionInput,
  ): Promise<CustomerEmailConnectionRecord | null> {
    const assignments: string[] = [];
    const params: unknown[] = [workspaceId, id];
    const addAssignment = (column: string, value: unknown): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };

    if ("displayName" in input) addAssignment("display_name", input.displayName);
    if ("senderEmail" in input) addAssignment("sender_email", input.senderEmail);
    if ("senderName" in input) addAssignment("sender_name", input.senderName ?? null);
    if ("replyToEmail" in input) addAssignment("reply_to_email", input.replyToEmail ?? null);
    if ("status" in input) addAssignment("status", input.status);
    if ("lastHealthStatus" in input) addAssignment("last_health_status", input.lastHealthStatus ?? null);
    if ("lastHealthCheckedAt" in input) addAssignment("last_health_checked_at", input.lastHealthCheckedAt ?? null);
    if ("lastErrorCode" in input) addAssignment("last_error_code", input.lastErrorCode ?? null);

    if (assignments.length === 0) {
      return this.findById(workspaceId, id);
    }

    const [row] = await this.database.query<CustomerEmailConnectionRow>(
      `UPDATE customer_email_connections
       SET ${assignments.join(", ")}, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      params,
    );
    return row ? mapRecord(row) : null;
  }

  async countSkillReferences(workspaceId: string, id: string): Promise<number> {
    // Skill tables are absent in a few focused repository schemas, so keep this
    // guard tolerant while enforcing references through the shared skill spine.
    const [table] = await this.database.query<{ to_regclass: string | null }>(
      "SELECT to_regclass('agent_skills')",
    );
    if (!table?.to_regclass) {
      return 0;
    }
    const [row] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM agent_skills s
       WHERE s.kind = 'customer_email'
         AND s.workspace_id = $1
         AND s.target_type = 'customer_email_connection'
         AND s.target_id = $2`,
      [workspaceId, id],
    );
    return Number(row?.count ?? 0);
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const affected = await this.database.execute(
      `DELETE FROM customer_email_connections WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id],
    );
    return affected > 0;
  }
}
