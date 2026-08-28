import { clockTimestamp, laterTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * Advances the durable per-agent skills freshness watermark `AgentSkillRepository.latestUpdatedAt`
 * reads — touched in the same transaction as the create/update it accompanies (a DB trigger
 * covers deletes performed by *any* writer, including the webhook/email/external-MCP/Slack skill
 * repositories that share the `agent_skills` table without calling this; see migration 154).
 *
 * Uses `clock_timestamp()` (the wall-clock instant this statement actually runs), not `now()`
 * (fixed at the enclosing transaction's start): a transaction that begins early but is delayed
 * and commits late, after a later-starting transaction already advanced the watermark, must not
 * stamp its write with its own stale start-of-transaction time and clobber that newer value. The
 * `ON CONFLICT` update also takes the `GREATEST` of the stored and proposed values as a
 * storage-level backstop that the watermark can only move forward, independent of caller-side
 * timing.
 *
 * Exported standalone — not a private repository method — so a test can drive it directly through
 * two independently-controlled transactions (proving the interleaving above doesn't regress the
 * stored value) without going through `AgentSkillRepository`'s own transaction wrapper.
 */
export const touchAgentSkillsWatermark = async (executor: Db, workspaceId: string, agentId: string): Promise<void> => {
  await executor
    .insertInto("agent_skills_watermarks")
    .values({ agent_id: agentId, workspace_id: workspaceId, updated_at: clockTimestamp() })
    .onConflict((oc) =>
      oc.column("agent_id").doUpdateSet((eb) => ({
        updated_at: laterTimestamp(eb.ref("agent_skills_watermarks.updated_at"), eb.ref("excluded.updated_at")),
      })),
    )
    .execute();
};
