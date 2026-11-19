import type { AudiencePulseHistoryHorizonSource } from "../../modules/audiencePulse/contracts.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/** Reads the two workspace facts that bound how far back Audience Pulse can compare. */
export class AudiencePulseHistoryHorizonRepository implements AudiencePulseHistoryHorizonSource {
  constructor(private readonly db: Db) {}

  async read(workspaceId: string): Promise<{ workspaceCreatedAt: Date; conversationRetentionDays: number | null } | null> {
    const row = await this.db
      .selectFrom("workspaces")
      .select(["created_at", "conversation_retention_days"])
      .where("id", "=", workspaceId)
      .executeTakeFirst();
    return row
      ? { workspaceCreatedAt: new Date(row.created_at), conversationRetentionDays: row.conversation_retention_days }
      : null;
  }
}
