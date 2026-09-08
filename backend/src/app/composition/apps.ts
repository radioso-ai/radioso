import type { Kysely, Transaction } from "kysely";

import {
  AppConnectionRepository,
  AppConnectionService,
  AppExecutionEligibilityService,
  AppGrantRepository,
  AppInstallationLifecycleService,
  AppInstallationPlanRepository,
  AppInstallationPlanService,
  AppInstallationQueryService,
  AppInstallationRepository,
  AppLifecycleOperationRepository,
  AppReleaseAdmissionService,
  AppReleaseRepository,
  createNoopAppContributionStaging,
  createNoopAppManagedDataDisposition,
  createUnavailableAppRuntimeProvisioning,
  createUnavailableAppSecretCipher,
  type AppConnectionRepositoryPort,
  type AppContributionStagingPort,
  type AppExecutionEligibilityPort,
  type AppGrantRepositoryPort,
  type AppInstallationPlanRepositoryPort,
  type AppInstallationRepositoryPort,
  type AppLifecycleOperationRepositoryPort,
  type AppManagedDataDispositionPort,
  type AppOperatorAuthorizationPort,
  type AppReleaseRepositoryPort,
  type AppRuntimeProvisioningPort,
  type AppSecretCipherPort,
  type AppsUnitOfWork,
  type BuiltInAppRelease,
} from "../../modules/apps/public.js";
import type { AccountPermission, AuthenticatedPrincipal } from "../../modules/account/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import { AppError } from "../../shared/domain/errors.js";
import { encryptField } from "../../shared/infra/crypto/fieldEncryption.js";
import type { DB } from "../../shared/infra/kysely/schema.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";

/**
 * The permission an operator needs to change what an App may do in a workspace.
 * Installing one grants a third-party runtime host capabilities, so it sits with the
 * workspace administrator rather than with everyone who can edit an agent.
 */
export const APP_ADMINISTRATION_PERMISSION: AccountPermission = "workspace.apps.manage";

const ENCRYPTION_KEY_NAME = "CONNECTOR_ENCRYPTION_KEY";

interface AppsRepositories {
  readonly releases: AppReleaseRepositoryPort;
  readonly installations: AppInstallationRepositoryPort;
  readonly plans: AppInstallationPlanRepositoryPort;
  readonly grants: AppGrantRepositoryPort;
  readonly connections: AppConnectionRepositoryPort;
  readonly operations: AppLifecycleOperationRepositoryPort;
}

export const createAppRepositories = (db: Db): AppsRepositories => ({
  releases: new AppReleaseRepository(db),
  installations: new AppInstallationRepository(db),
  plans: new AppInstallationPlanRepository(db),
  grants: new AppGrantRepository(db),
  connections: new AppConnectionRepository(db),
  operations: new AppLifecycleOperationRepository(db),
});

/**
 * Binds the Apps repositories to one Postgres transaction, so a saga step's database
 * effects and the cursor that records them commit or roll back together.
 */
export const createAppsUnitOfWork = (db: Kysely<DB>): AppsUnitOfWork => ({
  run: (work) => db.transaction().execute((transaction: Transaction<DB>) => work(createAppRepositories(transaction))),
});

interface AppsCompositionDependencies {
  readonly repositories: AppsRepositories;
  readonly unitOfWork: AppsUnitOfWork;
  readonly audit: Pick<AuditPort, "record">;
  readonly logger: AppLogger;
  readonly accountAccessService: {
    requirePermission(input: {
      accountId?: string;
      userId?: string | null;
      principal?: AuthenticatedPrincipal | null;
      permission: AccountPermission;
      workspaceId?: string | null;
    }): Promise<void>;
  };
  /** Base64 AES key shared with the platform's other at-rest secrets. Absent means binding fails closed. */
  readonly secretEncryptionKey?: string;
  /** The releases Radioso ships. Empty until a first-party App registers itself. */
  readonly builtInReleases?: readonly BuiltInAppRelease[];
  /** `null` when this host cannot determine its own version, which fails admission closed. */
  readonly runningRadiosoVersion: string | null;
  readonly runtimeProvisioning?: AppRuntimeProvisioningPort;
  readonly contributionStaging?: AppContributionStagingPort;
  readonly dataDisposition?: AppManagedDataDispositionPort;
}

interface AppsServices {
  readonly appReleaseAdmissionService: AppReleaseAdmissionService;
  readonly appInstallationPlanService: AppInstallationPlanService;
  readonly appInstallationLifecycleService: AppInstallationLifecycleService;
  readonly appInstallationQueryService: AppInstallationQueryService;
  readonly appConnectionService: AppConnectionService;
  readonly appExecutionEligibility: AppExecutionEligibilityPort;
}

/**
 * Assembles the Apps control plane. The defaults here are what a Radioso that ships
 * without a hosted App runtime does: nothing provisions, nothing stages, nothing is
 * disposed, and a connection secret cannot be stored without a key. None of those are
 * product rules — each is the absence of an implementation, and the domain states what
 * the absence means.
 */
export const createAppsServices = (dependencies: AppsCompositionDependencies): AppsServices => {
  const { repositories, unitOfWork, audit, logger, runningRadiosoVersion } = dependencies;

  // A closure, not the service instance: a port method held as a value loses its
  // receiver, and this one is called from inside a durable saga. It also separates a
  // refusal from a failure to answer, because only the first is a statement about the
  // operator and only the first may compensate a running installation.
  const authorization: AppOperatorAuthorizationPort = {
    authorizeAppAdministration: async (principal, workspaceId) => {
      try {
        await dependencies.accountAccessService.requirePermission({
          accountId: principal.accountId,
          userId: principal.userId,
          workspaceId,
          permission: APP_ADMINISTRATION_PERMISSION,
        });
        return { ok: true };
      } catch (error) {
        const denied = error instanceof AppError && (error.statusCode === 403 || error.statusCode === 404);
        if (!denied) {
          logger.warn(
            { workspaceId, err: { name: error instanceof Error ? error.name : "unknown" } },
            "App administration permission could not be evaluated",
          );
        }
        return { ok: false, outcome: denied ? "denied" : "indeterminate" };
      }
    },
  };

  const cipher: AppSecretCipherPort = dependencies.secretEncryptionKey
    ? {
      keyId: ENCRYPTION_KEY_NAME,
      encrypt: (plaintext) => encryptField(plaintext, dependencies.secretEncryptionKey as string, {
        keyName: ENCRYPTION_KEY_NAME,
      }),
    }
    : createUnavailableAppSecretCipher(ENCRYPTION_KEY_NAME);

  const appReleaseAdmissionService = new AppReleaseAdmissionService({
    releases: repositories.releases,
    builtInReleases: dependencies.builtInReleases ?? [],
    audit,
    logger,
    runningRadiosoVersion,
  });

  const appInstallationPlanService = new AppInstallationPlanService({
    releases: repositories.releases,
    installations: repositories.installations,
    connections: repositories.connections,
    plans: repositories.plans,
    authorization,
    audit,
    runningRadiosoVersion,
  });

  const appInstallationLifecycleService = new AppInstallationLifecycleService({
    installations: repositories.installations,
    plans: repositories.plans,
    releases: repositories.releases,
    connections: repositories.connections,
    operations: repositories.operations,
    unitOfWork,
    runtimeProvisioning: dependencies.runtimeProvisioning ?? createUnavailableAppRuntimeProvisioning(),
    contributionStaging: dependencies.contributionStaging ?? createNoopAppContributionStaging(),
    dataDisposition: dependencies.dataDisposition ?? createNoopAppManagedDataDisposition(),
    authorization,
    audit,
    logger,
    runningRadiosoVersion,
  });

  const appInstallationQueryService = new AppInstallationQueryService({
    installations: repositories.installations,
    releases: repositories.releases,
    grants: repositories.grants,
    connections: repositories.connections,
    operations: repositories.operations,
  });

  const appConnectionService = new AppConnectionService({
    installations: repositories.installations,
    releases: repositories.releases,
    connections: repositories.connections,
    operations: repositories.operations,
    unitOfWork,
    cipher,
    authorization,
    audit,
  });

  const appExecutionEligibility = new AppExecutionEligibilityService({
    installations: repositories.installations,
    releases: repositories.releases,
    grants: repositories.grants,
    connections: repositories.connections,
    runningRadiosoVersion,
  });

  return {
    appReleaseAdmissionService,
    appInstallationPlanService,
    appInstallationLifecycleService,
    appInstallationQueryService,
    appConnectionService,
    appExecutionEligibility,
  };
};
