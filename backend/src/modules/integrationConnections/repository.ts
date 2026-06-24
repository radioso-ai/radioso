import { randomUUID } from "node:crypto";

import type { Updateable } from "kysely";

import { currentTimestamp, jsonbConcat, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { IntegrationConnections } from "../../shared/infra/kysely/schema.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  CreateIntegrationConnectionInput,
  IntegrationConnectionHealthStatus,
  IntegrationConnectionRecord,
  IntegrationConnectionStatus,
  UpdateIntegrationConnectionInput,
} from "./domain.js";

export interface IntegrationConnectionRow {
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

const COLUMNS = [
  "id",
  "workspace_id",
  "oauth_connection_id",
  "provider",
  "display_name",
  "status",
  "last_health_status",
  "last_health_checked_at",
  "last_error_code",
  "config",
  "created_at",
  "updated_at",
] as const;

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

// True only when a provider scope must be applied. An empty/absent set leaves the
// query unconstrained, matching the raw SQL which appended no clause in that case.
const hasScope = (providers?: readonly string[]): providers is readonly string[] =>
  Boolean(providers && providers.length > 0);

export class IntegrationConnectionRepository implements IntegrationConnectionRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: CreateIntegrationConnectionInput): Promise<IntegrationConnectionRecord> {
    const row = await this.db
      .insertInto("integration_connections")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        oauth_connection_id: input.oauthConnectionId,
        provider: input.provider,
        display_name: input.displayName,
        status: input.status ?? "authorized",
        last_health_status: input.lastHealthStatus ?? null,
        last_health_checked_at: input.lastHealthCheckedAt ?? null,
        last_error_code: input.lastErrorCode ?? null,
        config: toJsonb(input.config ?? {}),
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return mapRecord(row as IntegrationConnectionRow);
  }

  async findById(
    workspaceId: string,
    id: string,
    providers?: readonly string[],
  ): Promise<IntegrationConnectionRecord | null> {
    let query = this.db
      .selectFrom("integration_connections")
      .select(COLUMNS)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id);
    if (hasScope(providers)) {
      query = query.where("provider", "in", providers);
    }
    const row = await query.executeTakeFirst();
    return row ? mapRecord(row as IntegrationConnectionRow) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<IntegrationConnectionRecord[]> {
    const rows = await this.db
      .selectFrom("integration_connections")
      .select(COLUMNS)
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => mapRecord(row as IntegrationConnectionRow));
  }

  async listByWorkspaceProvider(workspaceId: string, provider: string): Promise<IntegrationConnectionRecord[]> {
    const rows = await this.db
      .selectFrom("integration_connections")
      .select(COLUMNS)
      .where("workspace_id", "=", workspaceId)
      .where("provider", "=", provider)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => mapRecord(row as IntegrationConnectionRow));
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateIntegrationConnectionInput,
    providers?: readonly string[],
  ): Promise<IntegrationConnectionRecord | null> {
    const assignments: Updateable<IntegrationConnections> = {};
    if ("oauthConnectionId" in input) assignments.oauth_connection_id = input.oauthConnectionId;
    if ("displayName" in input) assignments.display_name = input.displayName;
    if ("status" in input) assignments.status = input.status;
    if ("lastHealthStatus" in input) assignments.last_health_status = input.lastHealthStatus ?? null;
    if ("lastHealthCheckedAt" in input) assignments.last_health_checked_at = input.lastHealthCheckedAt ?? null;
    if ("lastErrorCode" in input) assignments.last_error_code = input.lastErrorCode ?? null;

    const hasConfig = "config" in input;
    if (!hasConfig && Object.keys(assignments).length === 0) {
      return this.findById(workspaceId, id, providers);
    }

    let query = this.db
      .updateTable("integration_connections")
      .set((eb) => ({
        ...assignments,
        // Shallow jsonb merge (right keys win), mirroring `config = config || $n::jsonb`.
        ...(hasConfig ? { config: jsonbConcat(eb.ref("config"), toJsonb(input.config ?? {})) } : {}),
        updated_at: currentTimestamp(),
      }))
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id);
    if (hasScope(providers)) {
      query = query.where("provider", "in", providers);
    }
    const row = await query.returning(COLUMNS).executeTakeFirst();
    return row ? mapRecord(row as IntegrationConnectionRow) : null;
  }

  async remove(workspaceId: string, id: string, providers?: readonly string[]): Promise<boolean> {
    let query = this.db
      .deleteFrom("integration_connections")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id);
    if (hasScope(providers)) {
      query = query.where("provider", "in", providers);
    }
    const result = await query.executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
