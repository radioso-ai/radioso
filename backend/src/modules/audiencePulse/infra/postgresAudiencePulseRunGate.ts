import type { Kysely } from "kysely";

import type { AudiencePulseRunGate, AudiencePulseRunLease } from "../contracts.js";
import type { DB } from "../../../shared/infra/kysely/schema.js";
import {
  sessionAdvisoryUnlock,
  trySessionAdvisoryLock,
} from "../../../shared/infra/kysely/sqlHelpers.js";

const keyForWorkspace = (workspaceId: string): string => `radioso:audience-pulse:${workspaceId}`;

/**
 * Holds a Postgres session advisory lock on one pinned Kysely connection. The callback
 * stays open until release, so another process/replica cannot acquire it; connection
 * loss releases the server-side lock automatically.
 */
export class PostgresAudiencePulseRunGate implements AudiencePulseRunGate {
  constructor(private readonly db: Kysely<DB>) {}

  async tryAcquire(workspaceId: string): Promise<AudiencePulseRunLease | null> {
    const key = keyForWorkspace(workspaceId);
    let releaseHold: (() => void) | null = null;
    let settleAcquisition: ((value: boolean) => void) | null = null;
    let rejectAcquisition: ((error: unknown) => void) | null = null;
    const acquired = new Promise<boolean>((resolve, reject) => {
      settleAcquisition = resolve;
      rejectAcquisition = reject;
    });
    const holdReleased = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let lockHeld = false;
    let acquisitionSettled = false;

    const hold = this.db.connection().execute(async (connection) => {
      try {
        const result = await trySessionAdvisoryLock(key).execute(connection);
        lockHeld = result.rows[0]?.acquired ?? false;
        acquisitionSettled = true;
        settleAcquisition?.(lockHeld);
        if (!lockHeld) return;
        await holdReleased;
      } catch (error) {
        if (!acquisitionSettled) {
          acquisitionSettled = true;
          rejectAcquisition?.(error);
        }
        throw error;
      } finally {
        if (lockHeld) {
          await sessionAdvisoryUnlock(key).execute(connection).catch(() => undefined);
        }
      }
    });

    // The hold owns a long-lived connection by design. Its terminal error either rejects
    // acquisition or follows a release; do not leave an unhandled rejection behind.
    void hold.catch(() => undefined);
    if (!(await acquired)) return null;

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        releaseHold?.();
        await hold.catch(() => undefined);
      },
    };
  }
}
