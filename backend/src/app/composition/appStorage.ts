import type { Kysely } from "kysely";

import type { AuditService } from "../../modules/audit/contracts/index.js";
import {
  AppStorageRepository,
  createAppStorageDisposition,
  createAppStorageExpirySweeper,
  createAppStorageService,
  type AppStorageAuditEvent,
  type AppStorageAuditPort,
  type AppStorageDisposition,
  type AppStorageExpirySweeper,
  type AppStorageRepositoryPort,
  type AppStorageService,
} from "../../modules/appStorage/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * Puts `app.data.*` on the existing audit spine. The storage domain names the
 * event and its counts; where an audit event is stored, and what an operator
 * reads it through, stays the audit module's business.
 */
export const createAppStorageAuditSink = (auditService: AuditService): AppStorageAuditPort => ({
  async record(event: AppStorageAuditEvent): Promise<void> {
    await auditService.record({
      workspaceId: event.workspaceId,
      eventType: event.eventType,
      eventStatus: event.eventStatus,
      // The installation is an identity, so it belongs in the trail; a record key
      // and a stored value are customer data, and the domain never puts either
      // into an event to begin with.
      metadata: { ...event.metadata, installationId: event.installationId },
    });
  },
});

export interface AppStorageComposition {
  repository: AppStorageRepositoryPort;
  service: AppStorageService;
  disposition: AppStorageDisposition;
  /**
   * Exposed, not scheduled. Reads already hide an expired record, so a sweep
   * reclaims space rather than enforcing expiry, and the runtime that owns
   * background work decides when to run one.
   */
  expirySweeper: AppStorageExpirySweeper;
}

/**
 * Assembles managed App Storage: the generic Postgres repository, the capability
 * service the App gateway calls through, the disposition operations an operator
 * drives, and the expiry sweeper. It wires implementations and holds no rules —
 * every decision about what a record may contain, which operations a collection
 * permits, and what a quota admits lives in `modules/appStorage`.
 */
export const createAppStorageComposition = (options: {
  kysely: Kysely<DB>;
  auditService: AuditService;
}): AppStorageComposition => {
  const repository = new AppStorageRepository(options.kysely);
  const audit = createAppStorageAuditSink(options.auditService);

  return {
    repository,
    service: createAppStorageService({ repository }),
    disposition: createAppStorageDisposition({ repository, audit }),
    expirySweeper: createAppStorageExpirySweeper({ repository }),
  };
};
