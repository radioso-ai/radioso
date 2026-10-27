import type { Kysely } from "kysely";

import type { DB } from "../../../shared/infra/kysely/schema.js";
import { sessionAdvisoryUnlock, trySessionAdvisoryLock } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { VoiceRuntimeConnectionLock } from "../domain.js";

/** Namespaced, so no other advisory-lock user's key can collide with an agent's. */
const lockKeyOf = (agentId: string): string => `radioso:voice-runtime-connection:${agentId}`;

/**
 * The agent's runtime connection lock as a Postgres session advisory lock, held on one pinned
 * connection for as long as the work runs, so every backend instance sees it. A connection that
 * drops releases the lock with it.
 */
export class PostgresVoiceRuntimeConnectionLock implements VoiceRuntimeConnectionLock {
  constructor(private readonly db: Kysely<DB>) {}

  run<T>(agent: { workspaceId: string; agentId: string }, work: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    const key = lockKeyOf(agent.agentId);
    return this.db.connection().execute(async (connection) => {
      const result = await trySessionAdvisoryLock(key).execute(connection);
      if (!(result.rows[0]?.acquired ?? false)) return { ran: false };
      try {
        return { ran: true, value: await work() };
      } finally {
        await sessionAdvisoryUnlock(key).execute(connection).catch(() => undefined);
      }
    });
  }
}
