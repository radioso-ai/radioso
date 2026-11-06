import { randomUUID } from "node:crypto";

import type { McpAuthMethod, McpConnectionStatus } from "../../modules/externalSkills/domain.js";
import { sql } from "kysely";

import { currentTimestamp, tableExists } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface McpConnectionRecord {
  id: string;
  workspaceId: string;
  displayName: string;
  serverUrl: string;
  authMethod: McpAuthMethod;
  credentialCiphertext: string | null;
  oauthClientCiphertext: string | null;
  oauthFlowCiphertext: string | null;
  status: McpConnectionStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** One agent whose skills use a connection, labelled the way the dashboard labels that agent. */
export interface McpConnectionAgentUsage {
  connectionId: string;
  agentId: string;
  agentName: string;
}

export interface CreateMcpConnectionInput {
  workspaceId: string;
  displayName: string;
  serverUrl: string;
  authMethod: McpAuthMethod;
  credentialCiphertext?: string | null;
  oauthClientCiphertext?: string | null;
  status?: McpConnectionStatus;
}

export interface UpdateMcpConnectionInput {
  displayName?: string;
  credentialCiphertext?: string;
  status?: McpConnectionStatus;
}

interface McpConnectionRow {
  id: string;
  workspace_id: string;
  display_name: string;
  server_url: string;
  auth_method: McpAuthMethod;
  credential_ciphertext: string | null;
  oauth_client_ciphertext: string | null;
  oauth_flow_ciphertext: string | null;
  status: McpConnectionStatus;
  created_at: Date;
  updated_at: Date;
}

const mapRecord = (row: McpConnectionRow): McpConnectionRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  displayName: row.display_name,
  serverUrl: row.server_url,
  authMethod: row.auth_method,
  credentialCiphertext: row.credential_ciphertext,
  oauthClientCiphertext: row.oauth_client_ciphertext,
  oauthFlowCiphertext: row.oauth_flow_ciphertext,
  status: row.status,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const mcpConnectionColumns = [
  "id",
  "workspace_id",
  "display_name",
  "server_url",
  "auth_method",
  "credential_ciphertext",
  "oauth_client_ciphertext",
  "oauth_flow_ciphertext",
  "status",
  "created_at",
  "updated_at",
] as const;

export interface McpConnectionRepositoryPort {
  create(input: CreateMcpConnectionInput): Promise<McpConnectionRecord>;
  findById(workspaceId: string, id: string): Promise<McpConnectionRecord | null>;
  listByWorkspace(workspaceId: string): Promise<McpConnectionRecord[]>;
  /** The connections one agent's skills are bound to, for projecting that agent's configuration. */
  listUsedByAgent(workspaceId: string, agentId: string): Promise<McpConnectionRecord[]>;
  /** Which agents use the workspace's connections, or one connection when an id is given. */
  listAgentUsage(workspaceId: string, connectionId?: string): Promise<McpConnectionAgentUsage[]>;
  updateStatus(workspaceId: string, id: string, status: McpConnectionStatus): Promise<McpConnectionRecord | null>;
  update(workspaceId: string, id: string, input: UpdateMcpConnectionInput): Promise<McpConnectionRecord | null>;
  setOauthFlow(workspaceId: string, id: string, oauthFlowCiphertext: string): Promise<McpConnectionRecord | null>;
  setOauthTokens(
    workspaceId: string,
    id: string,
    credentialCiphertext: string,
  ): Promise<McpConnectionRecord | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
}

export class McpConnectionRepository implements McpConnectionRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: CreateMcpConnectionInput): Promise<McpConnectionRecord> {
    const row = await this.db
      .insertInto("mcp_connections")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        display_name: input.displayName,
        server_url: input.serverUrl,
        auth_method: input.authMethod,
        credential_ciphertext: input.credentialCiphertext ?? null,
        oauth_client_ciphertext: input.oauthClientCiphertext ?? null,
        status: input.status ?? "unconfigured",
      })
      .returning(mcpConnectionColumns)
      .executeTakeFirstOrThrow();
    return mapRecord(row as McpConnectionRow);
  }

  /** Persist the in-flight authorization (PKCE/state); sets status back to unconfigured. */
  async setOauthFlow(
    workspaceId: string,
    id: string,
    oauthFlowCiphertext: string,
  ): Promise<McpConnectionRecord | null> {
    const row = await this.db
      .updateTable("mcp_connections")
      .set({ oauth_flow_ciphertext: oauthFlowCiphertext, updated_at: currentTimestamp() })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .returning(mcpConnectionColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as McpConnectionRow) : null;
  }

  /** Store freshly issued/refreshed OAuth tokens, mark authorized, and clear the flow. */
  async setOauthTokens(
    workspaceId: string,
    id: string,
    credentialCiphertext: string,
  ): Promise<McpConnectionRecord | null> {
    const row = await this.db
      .updateTable("mcp_connections")
      .set({
        credential_ciphertext: credentialCiphertext,
        oauth_flow_ciphertext: null,
        status: "authorized",
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .returning(mcpConnectionColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as McpConnectionRow) : null;
  }

  async findById(workspaceId: string, id: string): Promise<McpConnectionRecord | null> {
    const row = await this.db
      .selectFrom("mcp_connections")
      .select(mcpConnectionColumns)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row as McpConnectionRow) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<McpConnectionRecord[]> {
    const rows = await this.db
      .selectFrom("mcp_connections")
      .select(mcpConnectionColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => mapRecord(row as McpConnectionRow));
  }

  async listUsedByAgent(workspaceId: string, agentId: string): Promise<McpConnectionRecord[]> {
    const rows = await this.db
      .selectFrom("mcp_connections")
      .select(mcpConnectionColumns)
      .where("workspace_id", "=", workspaceId)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("agent_skills")
            .select("agent_skills.id")
            .where("agent_skills.agent_id", "=", agentId)
            .where("agent_skills.kind", "=", "external_mcp")
            .where("agent_skills.target_type", "=", "mcp_connection")
            .whereRef("agent_skills.target_id", "=", sql<string>`mcp_connections.id::text`),
        ),
      )
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => mapRecord(row as McpConnectionRow));
  }

  async listAgentUsage(workspaceId: string, connectionId?: string): Promise<McpConnectionAgentUsage[]> {
    const usage = this.db
      .selectFrom("agent_skills as skill")
      .innerJoin("agents as agent", "agent.id", "skill.agent_id")
      .select([
        "skill.target_id as connectionId",
        "agent.id as agentId",
        sql<string>`COALESCE(NULLIF(agent.internal_name, ''), agent.name)`.as("agentName"),
      ])
      .distinct()
      .where("skill.workspace_id", "=", workspaceId)
      .where("skill.kind", "=", "external_mcp")
      .where("skill.target_type", "=", "mcp_connection")
      .where("skill.target_id", "is not", null)
      .orderBy("agentName")
      .orderBy("agentId");
    const rows = await (connectionId === undefined ? usage : usage.where("skill.target_id", "=", connectionId)).execute();
    return rows.map((row) => ({ connectionId: row.connectionId ?? "", agentId: row.agentId, agentName: row.agentName }));
  }

  async updateStatus(
    workspaceId: string,
    id: string,
    status: McpConnectionStatus,
  ): Promise<McpConnectionRecord | null> {
    const row = await this.db
      .updateTable("mcp_connections")
      .set({ status, updated_at: currentTimestamp() })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .returning(mcpConnectionColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as McpConnectionRow) : null;
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateMcpConnectionInput,
  ): Promise<McpConnectionRecord | null> {
    const row = await this.db
      .updateTable("mcp_connections")
      .set({
        ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
        ...(input.credentialCiphertext !== undefined ? { credential_ciphertext: input.credentialCiphertext } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .returning(mcpConnectionColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as McpConnectionRow) : null;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    // Guard mirrors the original: only check references when agent_skills exists (it may be
    // absent in a partially-migrated schema), then soft-block the delete if still referenced.
    if (await tableExists(this.db, "agent_skills")) {
      const reference = await this.db
        .selectFrom("agent_skills")
        .select(({ fn }) => fn.count<string>("id").as("count"))
        .where("kind", "=", "external_mcp")
        .where("workspace_id", "=", workspaceId)
        .where("target_type", "=", "mcp_connection")
        .where("target_id", "=", id)
        .executeTakeFirst();
      if (Number(reference?.count ?? 0) > 0) {
        const error = new Error("MCP connection is still referenced by skills") as Error & { code?: string };
        error.code = "23503";
        throw error;
      }
    }

    const result = await this.db
      .deleteFrom("mcp_connections")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
