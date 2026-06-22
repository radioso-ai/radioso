import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import type { AgentSkillInvocationMode, AgentSkillKind, AgentSkillSpine } from "./domain.js";

export interface AgentSkillCreateRecord {
  workspaceId: string;
  agentId: string;
  skillName: string;
  kind: AgentSkillKind;
  targetType?: string | null;
  targetId?: string | null;
  config?: Record<string, unknown>;
  invocationMode: AgentSkillInvocationMode;
  enabled?: boolean;
}

export interface AgentSkillUpdateRecord {
  targetType?: string | null;
  targetId?: string | null;
  config?: Record<string, unknown>;
  invocationMode?: AgentSkillInvocationMode;
  enabled?: boolean;
}

export interface AgentSkillRepositoryPort {
  create(input: AgentSkillCreateRecord): Promise<AgentSkillSpine>;
  findById(workspaceId: string, agentId: string, id: string): Promise<AgentSkillSpine | null>;
  findByName(workspaceId: string, agentId: string, skillName: string): Promise<AgentSkillSpine | null>;
  findDefaultAnswer(workspaceId: string, agentId: string): Promise<AgentSkillSpine | null>;
  listByAgent(workspaceId: string, agentId: string): Promise<AgentSkillSpine[]>;
  update(workspaceId: string, agentId: string, id: string, input: AgentSkillUpdateRecord): Promise<AgentSkillSpine | null>;
  remove(workspaceId: string, agentId: string, id: string): Promise<boolean>;
}

interface AgentSkillRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  skill_name: string;
  kind: AgentSkillKind;
  target_type: string | null;
  target_id: string | null;
  config: Record<string, unknown>;
  invocation_mode: AgentSkillInvocationMode;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const columns = `id, workspace_id, agent_id, skill_name, kind, target_type, target_id,
  config, invocation_mode, enabled, created_at, updated_at`;

const mapRow = (row: AgentSkillRow): AgentSkillSpine => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  skillName: row.skill_name,
  kind: row.kind,
  targetType: row.target_type,
  targetId: row.target_id,
  config: row.config ?? {},
  invocationMode: row.invocation_mode,
  enabled: row.enabled,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class AgentSkillRepository implements AgentSkillRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(input: AgentSkillCreateRecord): Promise<AgentSkillSpine> {
    const [row] = await this.database.query<AgentSkillRow>(
      `INSERT INTO agent_skills (
         id, workspace_id, agent_id, skill_name, kind, target_type, target_id, config, invocation_mode, enabled
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING ${columns}`,
      [
        randomUUID(),
        input.workspaceId,
        input.agentId,
        input.skillName,
        input.kind,
        input.targetType ?? null,
        input.targetId ?? null,
        JSON.stringify(input.config ?? {}),
        input.invocationMode,
        input.enabled ?? true,
      ],
    );
    return mapRow(row);
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<AgentSkillSpine | null> {
    const [row] = await this.database.query<AgentSkillRow>(
      `SELECT ${columns} FROM agent_skills WHERE workspace_id = $1 AND agent_id = $2 AND id = $3`,
      [workspaceId, agentId, id],
    );
    return row ? mapRow(row) : null;
  }

  async findByName(workspaceId: string, agentId: string, skillName: string): Promise<AgentSkillSpine | null> {
    const [row] = await this.database.query<AgentSkillRow>(
      `SELECT ${columns} FROM agent_skills WHERE workspace_id = $1 AND agent_id = $2 AND skill_name = $3`,
      [workspaceId, agentId, skillName],
    );
    return row ? mapRow(row) : null;
  }

  async findDefaultAnswer(workspaceId: string, agentId: string): Promise<AgentSkillSpine | null> {
    const [row] = await this.database.query<AgentSkillRow>(
      `SELECT ${columns} FROM agent_skills
       WHERE workspace_id = $1 AND agent_id = $2 AND invocation_mode = 'default_answer'`,
      [workspaceId, agentId],
    );
    return row ? mapRow(row) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<AgentSkillSpine[]> {
    const rows = await this.database.query<AgentSkillRow>(
      `SELECT ${columns} FROM agent_skills
       WHERE workspace_id = $1 AND agent_id = $2
       ORDER BY skill_name ASC`,
      [workspaceId, agentId],
    );
    return rows.map(mapRow);
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: AgentSkillUpdateRecord,
  ): Promise<AgentSkillSpine | null> {
    const [row] = await this.database.query<AgentSkillRow>(
      `UPDATE agent_skills SET
         target_type = COALESCE($4, target_type),
         target_id = CASE WHEN $5::boolean THEN $6 ELSE target_id END,
         config = config || COALESCE($7::jsonb, '{}'::jsonb),
         invocation_mode = COALESCE($8, invocation_mode),
         enabled = COALESCE($9, enabled),
         updated_at = NOW()
       WHERE workspace_id = $1 AND agent_id = $2 AND id = $3
       RETURNING ${columns}`,
      [
        workspaceId,
        agentId,
        id,
        input.targetType ?? null,
        "targetId" in input,
        input.targetId ?? null,
        input.config ? JSON.stringify(input.config) : null,
        input.invocationMode ?? null,
        "enabled" in input ? input.enabled ?? null : null,
      ],
    );
    return row ? mapRow(row) : null;
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<boolean> {
    return (await this.database.execute(
      `DELETE FROM agent_skills WHERE workspace_id = $1 AND agent_id = $2 AND id = $3`,
      [workspaceId, agentId, id],
    )) > 0;
  }
}
