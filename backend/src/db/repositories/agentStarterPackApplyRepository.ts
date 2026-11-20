import { conflict } from "../../shared/domain/errors.js";
import { toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface StarterPackApplyRecord {
  id: string;
  requestFingerprint: string;
  result: unknown;
}

const isIdempotencyKeyViolation = (error: unknown): boolean => {
  const record = error as { code?: unknown; constraint?: unknown } | null;
  return record?.code === "23505" && record.constraint === "agent_starter_pack_applies_idempotency_key_key";
};

/**
 * The idempotency record of starter pack applies. Callers construct it on the transaction that
 * creates the pack's items, so the record and the items commit or roll back together.
 */
export class AgentStarterPackApplyRepository {
  constructor(private readonly db: Db) {}

  async findByKey(workspaceId: string, agentId: string, idempotencyKey: string): Promise<StarterPackApplyRecord | null> {
    const row = await this.db
      .selectFrom("agent_starter_pack_applies")
      .select(["id", "request_fingerprint", "result"])
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return row ? { id: row.id, requestFingerprint: row.request_fingerprint, result: row.result } : null;
  }

  async insert(input: {
    id: string;
    workspaceId: string;
    agentId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    result: unknown;
    actorAccountId: string | null;
  }): Promise<void> {
    try {
      await this.db
        .insertInto("agent_starter_pack_applies")
        .values({
          id: input.id,
          workspace_id: input.workspaceId,
          agent_id: input.agentId,
          idempotency_key: input.idempotencyKey,
          request_fingerprint: input.requestFingerprint,
          result: toJsonb(input.result),
          actor_account_id: input.actorAccountId,
        })
        .execute();
    } catch (error) {
      // Callers hold the agent's draft lock, so a second writer for the same key waits and then
      // sees this row. The unique index is the backstop if a caller ever skips the lock.
      if (isIdempotencyKeyViolation(error)) {
        throw conflict("This starter pack apply is already being processed");
      }
      throw error;
    }
  }
}
