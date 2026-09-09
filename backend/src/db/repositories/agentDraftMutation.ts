import type { Transaction } from "kysely";

import { conflict, notFound } from "../../shared/domain/errors.js";
import { currentTimestamp, toSanitizedJsonb, transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";
import {
  parseAgentRevisionSnapshot,
  type AgentRevisionSnapshot,
} from "../../modules/agents/agentRevision.js";

/** All draft writers and revision materializers serialize on this exact key. */
export const agentRevisionLockKey = (workspaceId: string, agentId: string): string =>
  `agent-revision:${workspaceId}:${agentId}`;

type AgentDraftMutationResult<T> =
  | { result: T; snapshot: AgentRevisionSnapshot }
  | { result: T; unchanged: true };

type AgentDraftMutationOperation<T> = (
  trx: Transaction<DB>,
  snapshot: AgentRevisionSnapshot,
) => Promise<AgentDraftMutationResult<T>>;

const isTransaction = (db: Db): db is Transaction<DB> => db.isTransaction;

/**
 * Runs one authored-resource command and its immutable draft projection as one
 * transaction. The lock is deliberately acquired before reading either storage
 * representation: a candidate, publication, or another scoped writer can only
 * observe the state before or after this command, never its normalized-row half.
 *
 * An operation must not call this helper again for the same agent. That would
 * advance the inner draft generation and invalidate the outer snapshot; the
 * guarded update below rejects the outer operation and rolls the whole nested
 * transaction back instead of persisting a stale projection.
 */
export const withAgentDraftMutation = async <T>(
  db: Db,
  workspaceId: string,
  agentId: string,
  operation: AgentDraftMutationOperation<T>,
): Promise<T> => {
  const execute = async (trx: Transaction<DB>): Promise<T> => {
    await transactionAdvisoryLock(agentRevisionLockKey(workspaceId, agentId)).execute(trx);
    const draft = await trx
      .selectFrom("agent_drafts")
      .select(["generation", "snapshot"])
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();
    if (!draft) {
      throw notFound("Agent draft not found");
    }

    const mutation = await operation(trx, parseAgentRevisionSnapshot(draft.snapshot));
    if ("unchanged" in mutation) {
      return mutation.result;
    }

    const snapshot = parseAgentRevisionSnapshot(mutation.snapshot);
    const updated = await trx
      .updateTable("agent_drafts")
      .set({
        generation: draft.generation + 1,
        snapshot: toSanitizedJsonb(snapshot),
        updated_at: currentTimestamp(),
      })
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("generation", "=", draft.generation)
      .returning("generation")
      .executeTakeFirst();
    if (!updated) {
      throw conflict("Agent draft changed during an atomic mutation");
    }
    return mutation.result;
  };

  return isTransaction(db) ? execute(db) : db.transaction().execute(execute);
};
