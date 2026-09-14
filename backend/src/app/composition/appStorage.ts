import type { Kysely } from "kysely";

import type { AuditOutboxPort } from "../../modules/audit/contracts/index.js";
import {
  AppStorageRepository,
  createAppStorageCompatibilityFacts,
  createAppStorageDisposition,
  createAppStorageIndexRebuilder,
  createAppStorageService,
  createAppStorageSweeper,
  type AppStorageAuditLogPort,
  type AppStorageCompatibilityFactsPort,
  type AppStorageDisposition,
  type AppStorageIndexRebuilder,
  type AppStorageRepositoryPort,
  type AppStorageService,
  type AppStorageSweeper,
} from "../../modules/appStorage/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";

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
   * collections rather than a correctness problem.
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
 *
 * Disposition commits its audit intent to the platform's audit outbox rather
 * than publishing it; the caller supplies the outbox port, and the audit
 * module's own composition is what assembles the dispatcher that publishes it.
 */
export const createAppStorageComposition = (options: {
  kysely: Kysely<DB>;
  auditOutbox: AuditOutboxPort;
  /**
   * Where a secondary audit failure is written. A disposition answers correctly
   * without it; what it buys is an outbox outage that is visible as itself rather
   * than only as trail entries nobody ever sees.
   */
  logger?: AppStorageAuditLogPort;
}): AppStorageComposition => {
  const repository = new AppStorageRepository(options.kysely, options.auditOutbox);

  return {
    repository,
    service: createAppStorageService({ repository }),
    compatibilityFacts: createAppStorageCompatibilityFacts({ repository }),
    disposition: createAppStorageDisposition({
      repository,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
    indexRebuilder: createAppStorageIndexRebuilder({ repository }),
    sweeper: createAppStorageSweeper({ repository }),
  };
};
