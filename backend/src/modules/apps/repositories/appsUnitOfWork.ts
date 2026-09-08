import type { AppAuditOutboxRepositoryPort } from "./appAuditOutboxRepository.js";
import type { AppConnectionRepositoryPort } from "./appConnectionRepository.js";
import type { AppGrantRepositoryPort } from "./appGrantRepository.js";
import type { AppInstallationPlanRepositoryPort } from "./appInstallationPlanRepository.js";
import type { AppInstallationRepositoryPort } from "./appInstallationRepository.js";
import type { AppLifecycleOperationRepositoryPort } from "./appLifecycleOperationRepository.js";
import type { AppReleaseRepositoryPort } from "./appReleaseRepository.js";

/** The repositories a lifecycle operation writes through. */
export interface AppsTransactionalRepositories {
  readonly installations: AppInstallationRepositoryPort;
  readonly plans: AppInstallationPlanRepositoryPort;
  readonly releases: AppReleaseRepositoryPort;
  readonly grants: AppGrantRepositoryPort;
  readonly connections: AppConnectionRepositoryPort;
  readonly operations: AppLifecycleOperationRepositoryPort;
  /** Audit intents, so a record of what happened commits with the thing that happened. */
  readonly auditOutbox: AppAuditOutboxRepositoryPort;
}

/**
 * One atomic unit of Apps persistence.
 *
 * Two things in this module are only correct when they commit together. Applying a plan
 * consumes the approval, creates the installation, and opens the operation: a crash
 * between any two of those leaves a consumed plan with nothing to resume, or a live
 * installation that blocks every future install. And a saga step that writes to the
 * database — approving grants, revoking them, entering a state — has to land with the
 * cursor that says it happened, or a resume repeats it.
 *
 * The port hands back repositories rather than a transaction handle so the domain never
 * learns what a transaction is made of.
 */
export interface AppsUnitOfWork {
  run<T>(
    work: (repositories: AppsTransactionalRepositories) => Promise<T>,
    options?: AppsUnitOfWorkOptions,
  ): Promise<T>;
}

export interface AppsUnitOfWorkOptions {
  /**
   * One consistent view for the whole unit, rather than the default per-statement one.
   *
   * A decision assembled from several reads — is this installation active, is its release
   * still usable, is this contribution granted, are its connections bound — is only an
   * answer if all of it describes the same instant. Read committed lets a disable land
   * between the first read and the last, which produces an answer that was never true.
   */
  readonly snapshot?: boolean;
}
