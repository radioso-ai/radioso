import type { Kysely } from "kysely";

import type { AuditService } from "../../modules/audit/contracts/index.js";
import {
  AppStorageRepository,
  createAppStorageCompatibilityFacts,
  createAppStorageDisposition,
  createAppStorageIndexRebuilder,
  createAppStorageService,
  createAppStorageSweeper,
  type AppStorageAuditEvent,
  type AppStorageAuditLogPort,
  type AppStorageAuditPort,
  type AppStorageCompatibilityFactsPort,
  type AppStorageDisposition,
  type AppStorageIndexRebuilder,
  type AppStorageRepositoryPort,
  type AppStorageService,
  type AppStorageSweeper,
} from "../../modules/appStorage/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * Puts `app.data.*` on the existing audit spine. The storage domain names the
 * event and its counts; where an audit event is stored, and what an operator
 * reads it through, stays the audit module's business.
 *
 * The sink is a publisher rather than a writer on the disposition's path. A
 * disposition commits its audit intent to storage's own outbox in the same
 * transaction as the change it describes, and `drainAuditOutbox` hands the
 * committed intents to this sink afterwards.
 */
export const createAppStorageAuditSink = (auditService: AuditService): AppStorageAuditPort => ({
  async record(event: AppStorageAuditEvent): Promise<void> {
    await auditService.record({
      workspaceId: event.workspaceId,
      eventType: event.eventType,
      eventStatus: event.eventStatus,
      // The installation is an identity, so it belongs in the trail; a record key
      // and a stored value are customer data, and the domain never puts either
      // into an event to begin with. The event id travels with it because
      // delivery is at-least-once: it is what an operator reading the trail twice
      // recognises one event by.
      //
      // A deleted workspace arrives as a null `workspaceId` and its former
      // identifier here. `audit_events.workspace_id` references `workspaces` and
      // is set to null when one is deleted, so this is the only shape in which
      // the storage outbox's deliberately surviving entries can be published at
      // all — attributing them to a workspace row that is gone would fail the
      // foreign key on every retry, forever.
      metadata: {
        ...event.metadata,
        installationId: event.installationId,
        eventId: event.eventId,
        ...(event.deletedWorkspaceId === null
          ? {}
          : { deletedWorkspaceId: event.deletedWorkspaceId }),
      },
    });
  },
});

export interface AppStorageComposition {
  repository: AppStorageRepositoryPort;
  service: AppStorageService;
  /**
   * The storage facts release admission asks for, deliberately apart from the
   * capability service. What an App may call and what a release admission may
   * learn about storage history are two surfaces, and only the first is exposed
   * through the App gateway.
   */
  compatibilityFacts: AppStorageCompatibilityFactsPort;
  disposition: AppStorageDisposition;
  /**
   * Builds a declared index over records written before it was declared. Release
   * admission reports which indexes a candidate needs rebuilt; running them is
   * what makes the candidate's queries answer about older records.
   */
  indexRebuilder: AppStorageIndexRebuilder;
  /**
   * Exposed, not scheduled. The runtime that owns background work decides when a
   * pass runs; what each pass is for differs. Expiry reclaims space a read and a
   * write already ignore, so it can run late. Retention is the only thing that
   * makes an operator's bounded hold end, so it cannot. The rebuild sweep drops
   * markers whose lease ran out, which is a tax on every write to their
   * collections rather than a correctness problem. The audit outbox drain on
   * `disposition` is the fourth pass with the same property: the trail is already
   * durable when a disposition returns, and draining is what publishes it.
   */
  sweeper: AppStorageSweeper;
}

/**
 * Assembles managed App Storage: the generic Postgres repository, the capability
 * service the App gateway calls through, the disposition operations an operator
 * drives, the index rebuilder release admission requires, and the maintenance
 * sweeper. It wires implementations and holds no rules —
 * every decision about what a record may contain, which operations a collection
 * permits, and what a quota admits lives in `modules/appStorage`.
 */
export const createAppStorageComposition = (options: {
  kysely: Kysely<DB>;
  auditService: AuditService;
  /**
   * Where a secondary audit failure is written. A disposition answers correctly
   * without it; what it buys is an outbox outage that is visible as itself rather
   * than only as trail entries nobody ever sees.
   */
  logger?: AppStorageAuditLogPort;
}): AppStorageComposition => {
  const repository = new AppStorageRepository(options.kysely);
  const audit = createAppStorageAuditSink(options.auditService);

  return {
    repository,
    service: createAppStorageService({ repository }),
    compatibilityFacts: createAppStorageCompatibilityFacts({ repository }),
    disposition: createAppStorageDisposition({
      repository,
      audit,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
    indexRebuilder: createAppStorageIndexRebuilder({ repository }),
    sweeper: createAppStorageSweeper({ repository }),
  };
};
