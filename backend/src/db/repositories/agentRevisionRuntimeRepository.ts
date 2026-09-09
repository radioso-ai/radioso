import {
  parseAgentRevisionSnapshot,
  type AgentRevision,
} from "../../modules/agents/agentRevision.js";
import type { AgentRevisionRuntimeReaderPort } from "../../modules/agents/runtime/agentRevisionRuntimeResolver.js";
import type { Db } from "../../shared/infra/kysely/types.js";

const mapRevision = (row: {
  id: string;
  snapshot: unknown;
  source_draft_generation: number;
  source_base_published_revision_id: string | null;
  created_at: Date;
  published_at: Date | null;
  published_version: number | null;
}): AgentRevision => ({
  id: row.id,
  snapshot: parseAgentRevisionSnapshot(row.snapshot),
  sourceDraftGeneration: row.source_draft_generation,
  sourceBasePublishedRevisionId: row.source_base_published_revision_id,
  createdAt: new Date(row.created_at),
  publishedAt: row.published_at ? new Date(row.published_at) : null,
  publishedVersion: row.published_version,
});

/** Postgres adapter for the narrow immutable runtime reader. */
export class AgentRevisionRuntimeRepository implements AgentRevisionRuntimeReaderPort {
  constructor(private readonly db: Db) {}

  async findCurrentPublished(input: { workspaceId: string; agentId: string }): Promise<AgentRevision | null> {
    const row = await this.db
      .selectFrom("agents as a")
      .innerJoin("agent_revisions as r", (join) =>
        join.onRef("r.id", "=", "a.published_revision_id")
          .onRef("r.agent_id", "=", "a.id")
          .onRef("r.workspace_id", "=", "a.workspace_id"),
      )
      .select([
        "r.id as id",
        "r.snapshot as snapshot",
        "r.source_draft_generation as source_draft_generation",
        "r.source_base_published_revision_id as source_base_published_revision_id",
        "r.created_at as created_at",
        "r.published_at as published_at",
        "r.published_version as published_version",
      ])
      .where("a.workspace_id", "=", input.workspaceId)
      .where("a.id", "=", input.agentId)
      .executeTakeFirst();
    return row ? mapRevision(row) : null;
  }

  async findRevision(input: { workspaceId: string; agentId: string; revisionId: string }): Promise<AgentRevision | null> {
    const row = await this.db
      .selectFrom("agent_revisions")
      .select([
        "id",
        "snapshot",
        "source_draft_generation",
        "source_base_published_revision_id",
        "created_at",
        "published_at",
        "published_version",
      ])
      .where("workspace_id", "=", input.workspaceId)
      .where("agent_id", "=", input.agentId)
      .where("id", "=", input.revisionId)
      .executeTakeFirst();
    return row ? mapRevision(row) : null;
  }
}
