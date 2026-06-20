import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { DatabaseExecutor } from "../../shared/infra/database.js";
import type {
  CreateIntegrationConnectionInput,
  IntegrationConnectionHealthStatus,
  IntegrationConnectionRecord,
  IntegrationConnectionStatus,
  UpdateIntegrationConnectionInput,
} from "./domain.js";

export interface IntegrationConnectionRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  oauth_connection_id: string;
  provider: string;
  display_name: string;
  status: IntegrationConnectionStatus;
  last_health_status: IntegrationConnectionHealthStatus | null;
  last_health_checked_at: Date | null;
  last_error_code: string | null;
  config: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  "id, workspace_id, oauth_connection_id, provider, display_name, status, last_health_status, last_health_checked_at, last_error_code, config, created_at, updated_at";

const mapRecord = (row: IntegrationConnectionRow): IntegrationConnectionRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  oauthConnectionId: row.oauth_connection_id,
  provider: row.provider,
  displayName: row.display_name,
  status: row.status,
  lastHealthStatus: row.last_health_status,
  lastHealthCheckedAt: row.last_health_checked_at ? new Date(row.last_health_checked_at) : null,
  lastErrorCode: row.last_error_code,
  config: row.config && typeof row.config === "object" ? row.config : {},
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface IntegrationConnectionRepositoryPort {
  create(input: CreateIntegrationConnectionInput): Promise<IntegrationConnectionRecord>;
  // `providers`, when supplied, scopes the id-based read/mutate paths to rows of
  // those providers. Callers that own a subset of the shared spine (e.g. customer
  // email) pass their provider set so they cannot read/mutate/delete another
  // provider's connection by id. The constraint is enforced in the SQL WHERE clause.
  findById(
    workspaceId: string,
    id: string,
    providers?: readonly string[],
  ): Promise<IntegrationConnectionRecord | null>;
  listByWorkspace(workspaceId: string): Promise<IntegrationConnectionRecord[]>;
  listByWorkspaceProvider(workspaceId: string, provider: string): Promise<IntegrationConnectionRecord[]>;
  update(
    workspaceId: string,
    id: string,
    input: UpdateIntegrationConnectionInput,
    providers?: readonly string[],
  ): Promise<IntegrationConnectionRecord | null>;
  remove(workspaceId: string, id: string, providers?: readonly string[]): Promise<boolean>;
}

// Builds an optional `AND provider = ANY(...)` clause, appending the array param
// and returning the SQL fragment referencing its positional index.
const providerScopeClause = (params: unknown[], providers?: readonly string[]): string => {
  if (!providers || providers.length === 0) {
    return "";
  }
  params.push([...providers]);
  return ` AND provider = ANY($${params.length}::text[])`;
};

export class IntegrationConnectionRepository implements IntegrationConnectionRepositoryPort {
  constructor(private readonly database: DatabaseExecutor) {}

  async create(input: CreateIntegrationConnectionInput): Promise<IntegrationConnectionRecord> {
    const [row] = await this.database.query<IntegrationConnectionRow>(
      `INSERT INTO integration_connections
         (id, workspace_id, oauth_connection_id, provider, display_name, status,
          last_health_status, last_health_checked_at, last_error_code, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.workspaceId,
        input.oauthConnectionId,
        input.provider,
        input.displayName,
        input.status ?? "authorized",
        input.lastHealthStatus ?? null,
        input.lastHealthCheckedAt ?? null,
        input.lastErrorCode ?? null,
        JSON.stringify(input.config ?? {}),
      ],
    );
    return mapRecord(row);
  }

  async findById(
    workspaceId: string,
    id: string,
    providers?: readonly string[],
  ): Promise<IntegrationConnectionRecord | null> {
    const params: unknown[] = [workspaceId, id];
    const scope = providerScopeClause(params, providers);
    const [row] = await this.database.query<IntegrationConnectionRow>(
      `SELECT ${COLUMNS} FROM integration_connections WHERE workspace_id = $1 AND id = $2${scope}`,
      params,
    );
    return row ? mapRecord(row) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<IntegrationConnectionRecord[]> {
    const rows = await this.database.query<IntegrationConnectionRow>(
      `SELECT ${COLUMNS}
       FROM integration_connections
       WHERE workspace_id = $1
       ORDER BY created_at ASC`,
      [workspaceId],
    );
    return rows.map(mapRecord);
  }

  async listByWorkspaceProvider(workspaceId: string, provider: string): Promise<IntegrationConnectionRecord[]> {
    const rows = await this.database.query<IntegrationConnectionRow>(
      `SELECT ${COLUMNS}
       FROM integration_connections
       WHERE workspace_id = $1 AND provider = $2
       ORDER BY created_at ASC`,
      [workspaceId, provider],
    );
    return rows.map(mapRecord);
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateIntegrationConnectionInput,
    providers?: readonly string[],
  ): Promise<IntegrationConnectionRecord | null> {
    const assignments: string[] = [];
    const params: unknown[] = [workspaceId, id];
    const addAssignment = (column: string, value: unknown): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };

    if ("oauthConnectionId" in input) addAssignment("oauth_connection_id", input.oauthConnectionId);
    if ("displayName" in input) addAssignment("display_name", input.displayName);
    if ("status" in input) addAssignment("status", input.status);
    if ("lastHealthStatus" in input) addAssignment("last_health_status", input.lastHealthStatus ?? null);
    if ("lastHealthCheckedAt" in input) addAssignment("last_health_checked_at", input.lastHealthCheckedAt ?? null);
    if ("lastErrorCode" in input) addAssignment("last_error_code", input.lastErrorCode ?? null);
    if ("config" in input) {
      params.push(JSON.stringify(input.config ?? {}));
      assignments.push(`config = config || $${params.length}::jsonb`);
    }

    if (assignments.length === 0) {
      return this.findById(workspaceId, id, providers);
    }

    const scope = providerScopeClause(params, providers);
    const [row] = await this.database.query<IntegrationConnectionRow>(
      `UPDATE integration_connections
       SET ${assignments.join(", ")}, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2${scope}
       RETURNING ${COLUMNS}`,
      params,
    );
    return row ? mapRecord(row) : null;
  }

  async remove(workspaceId: string, id: string, providers?: readonly string[]): Promise<boolean> {
    const params: unknown[] = [workspaceId, id];
    const scope = providerScopeClause(params, providers);
    const affected = await this.database.execute(
      `DELETE FROM integration_connections WHERE workspace_id = $1 AND id = $2${scope}`,
      params,
    );
    return affected > 0;
  }
}
