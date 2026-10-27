import { withSessionAdvisoryLock, type PinnableDatabase } from "../../../shared/infra/database.js";
import type { VoiceRuntimeConnectionLock } from "../domain.js";

/** Namespaced, so no other advisory-lock user's key can collide with an agent's. */
const lockKeyOf = (agentId: string): string => `radioso:voice-runtime-connection:${agentId}`;

/**
 * The agent's runtime connection lock as a Postgres session advisory lock, held on one pinned
 * connection for as long as the work runs, so every backend instance sees it. A connection that
 * drops releases the lock with it, and one whose unlock fails is closed rather than pooled.
 */
export class PostgresVoiceRuntimeConnectionLock implements VoiceRuntimeConnectionLock {
  constructor(private readonly database: PinnableDatabase) {}

  run<T>(agent: { workspaceId: string; agentId: string }, work: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    return withSessionAdvisoryLock(this.database, lockKeyOf(agent.agentId), work);
  }
}
