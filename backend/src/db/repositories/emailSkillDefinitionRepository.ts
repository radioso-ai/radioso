import { randomUUID } from "node:crypto";

import type {
  CustomerEmailSkillMode,
  CustomerEmailSkillDefinitionSummary,
} from "../../modules/customerEmail/domain.js";
import type { Database } from "../../shared/infra/database.js";

export interface EmailSkillDefinitionRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  connectionId: string;
  skillName: string;
  mode: CustomerEmailSkillMode;
  boundInputs: Record<string, unknown>;
  exposedInputs: CustomerEmailSkillDefinitionSummary["exposedInputs"];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEmailSkillDefinitionInput {
  workspaceId: string;
  agentId: string;
  connectionId: string;
  skillName: string;
  mode: CustomerEmailSkillMode;
  boundInputs: Record<string, unknown>;
  exposedInputs: CustomerEmailSkillDefinitionSummary["exposedInputs"];
  enabled?: boolean;
}

export interface UpdateEmailSkillDefinitionInput {
  mode?: CustomerEmailSkillMode;
  boundInputs?: Record<string, unknown>;
  exposedInputs?: CustomerEmailSkillDefinitionSummary["exposedInputs"];
  enabled?: boolean;
}

interface EmailSkillDefinitionRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  connection_id: string;
  skill_name: string;
  mode: CustomerEmailSkillMode;
  bound_inputs: Record<string, unknown>;
  exposed_inputs: CustomerEmailSkillDefinitionSummary["exposedInputs"];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  "id, workspace_id, agent_id, connection_id, skill_name, mode, bound_inputs, exposed_inputs, enabled, created_at, updated_at";

const mapRecord = (row: EmailSkillDefinitionRow): EmailSkillDefinitionRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  connectionId: row.connection_id,
  skillName: row.skill_name,
  mode: row.mode,
  boundInputs: row.bound_inputs ?? {},
  exposedInputs: row.exposed_inputs ?? {},
  enabled: row.enabled,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface EmailSkillDefinitionRepositoryPort {
  create(input: CreateEmailSkillDefinitionInput): Promise<EmailSkillDefinitionRecord>;
  findById(workspaceId: string, agentId: string, id: string): Promise<EmailSkillDefinitionRecord | null>;
  findEnabledByName(workspaceId: string, agentId: string, skillName: string): Promise<EmailSkillDefinitionRecord | null>;
  listByAgent(workspaceId: string, agentId: string): Promise<EmailSkillDefinitionRecord[]>;
  update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: UpdateEmailSkillDefinitionInput,
  ): Promise<EmailSkillDefinitionRecord | null>;
  remove(workspaceId: string, agentId: string, id: string): Promise<boolean>;
  countByConnection(workspaceId: string, connectionId: string): Promise<number>;
}

export class EmailSkillDefinitionRepository implements EmailSkillDefinitionRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(input: CreateEmailSkillDefinitionInput): Promise<EmailSkillDefinitionRecord> {
    const [row] = await this.database.query<EmailSkillDefinitionRow>(
      `INSERT INTO email_skill_definitions
         (id, workspace_id, agent_id, connection_id, skill_name, mode, bound_inputs, exposed_inputs, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.workspaceId,
        input.agentId,
        input.connectionId,
        input.skillName,
        input.mode,
        JSON.stringify(input.boundInputs ?? {}),
        JSON.stringify(input.exposedInputs ?? {}),
        input.enabled ?? true,
      ],
    );
    return mapRecord(row);
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<EmailSkillDefinitionRecord | null> {
    const [row] = await this.database.query<EmailSkillDefinitionRow>(
      `SELECT ${COLUMNS}
       FROM email_skill_definitions
       WHERE workspace_id = $1 AND agent_id = $2 AND id = $3`,
      [workspaceId, agentId, id],
    );
    return row ? mapRecord(row) : null;
  }

  async findEnabledByName(
    workspaceId: string,
    agentId: string,
    skillName: string,
  ): Promise<EmailSkillDefinitionRecord | null> {
    const [row] = await this.database.query<EmailSkillDefinitionRow>(
      `SELECT ${COLUMNS}
       FROM email_skill_definitions
       WHERE workspace_id = $1 AND agent_id = $2 AND skill_name = $3 AND enabled = TRUE`,
      [workspaceId, agentId, skillName],
    );
    return row ? mapRecord(row) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<EmailSkillDefinitionRecord[]> {
    const rows = await this.database.query<EmailSkillDefinitionRow>(
      `SELECT ${COLUMNS}
       FROM email_skill_definitions
       WHERE workspace_id = $1 AND agent_id = $2
       ORDER BY skill_name ASC`,
      [workspaceId, agentId],
    );
    return rows.map(mapRecord);
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: UpdateEmailSkillDefinitionInput,
  ): Promise<EmailSkillDefinitionRecord | null> {
    const assignments: string[] = [];
    const params: unknown[] = [workspaceId, agentId, id];
    const addAssignment = (column: string, value: unknown, cast = ""): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}${cast}`);
    };

    if ("mode" in input) addAssignment("mode", input.mode);
    if ("boundInputs" in input) addAssignment("bound_inputs", JSON.stringify(input.boundInputs ?? {}), "::jsonb");
    if ("exposedInputs" in input) addAssignment("exposed_inputs", JSON.stringify(input.exposedInputs ?? {}), "::jsonb");
    if ("enabled" in input) addAssignment("enabled", input.enabled);

    if (assignments.length === 0) {
      return this.findById(workspaceId, agentId, id);
    }

    const [row] = await this.database.query<EmailSkillDefinitionRow>(
      `UPDATE email_skill_definitions
       SET ${assignments.join(", ")}, updated_at = NOW()
       WHERE workspace_id = $1 AND agent_id = $2 AND id = $3
       RETURNING ${COLUMNS}`,
      params,
    );
    return row ? mapRecord(row) : null;
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<boolean> {
    const affected = await this.database.execute(
      `DELETE FROM email_skill_definitions WHERE workspace_id = $1 AND agent_id = $2 AND id = $3`,
      [workspaceId, agentId, id],
    );
    return affected > 0;
  }

  async countByConnection(workspaceId: string, connectionId: string): Promise<number> {
    const [row] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM email_skill_definitions
       WHERE workspace_id = $1 AND connection_id = $2`,
      [workspaceId, connectionId],
    );
    return Number(row?.count ?? 0);
  }
}
