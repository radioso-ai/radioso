import type { Kysely } from "kysely";

import type { AuditOutboxPort } from "../../modules/audit/contracts/index.js";
import {
  AppStorageRepository,
  createAppStorageCompatibilityFacts,
  createAppStorageDisposition,
  createAppStorageIndexRebuilder,
  createAppStorageService,
  createAppStorageSweeper,
  type AppStorageCompatibilityFactsPort,
  type AppStorageDiagnosticFields,
  type AppStorageDiagnosticsPort,
  type AppStorageDisposition,
  type AppStorageIndexRebuilder,
  type AppStorageRepositoryPort,
  type AppStorageService,
  type AppStorageSweeper,
} from "../../modules/appStorage/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";

/**
 * Adapts the platform logger to the narrow port every appStorage service
 * that converts an exception depends on. `error` rather than `warn`: both
 * codes this port ever reports mean the host's problem, not a deterministic
 * answer about the request.
 */
export const createAppStorageDiagnostics = (logger: AppLogger): AppStorageDiagnosticsPort => ({
  failure(fields: AppStorageDiagnosticFields, message: string): void {
    logger.error(fields, message);
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
   * Where every service here sends an exception it cannot attribute to the
   * caller before discarding it into a sanitized `internal` or `unavailable`
   * result. Mandatory: a missing migration, a schema drift, or a persistent
   * database fault must leave a cause an operator can act on, not just a
   * result the caller retries.
   */
  logger: AppLogger;
}): AppStorageComposition => {
  const repository = new AppStorageRepository(options.kysely, options.auditOutbox);
  const diagnostics = createAppStorageDiagnostics(options.logger);

  return {
    repository,
    service: createAppStorageService({ repository, diagnostics }),
    compatibilityFacts: createAppStorageCompatibilityFacts({ repository, diagnostics }),
    disposition: createAppStorageDisposition({ repository, diagnostics }),
    indexRebuilder: createAppStorageIndexRebuilder({ repository, diagnostics }),
    sweeper: createAppStorageSweeper({ repository, diagnostics }),
  };
};
