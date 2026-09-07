import {
  AppConnectionRepository,
  AppConnectionService,
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
  type AppGrantRepositoryPort,
  type AppInstallationPlanRepositoryPort,
  type AppInstallationRepositoryPort,
  type AppLifecycleOperationRepositoryPort,
  type AppManagedDataDispositionPort,
  type AppOperatorAuthorizationPort,
  type AppReleaseRepositoryPort,
  type AppRuntimeProvisioningPort,
  type AppSecretCipherPort,
  type BuiltInAppRelease,
} from "../../modules/apps/public.js";
import type { AccountPermission, AuthenticatedPrincipal } from "../../modules/account/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import { encryptField } from "../../shared/infra/crypto/fieldEncryption.js";
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

interface AppsCompositionDependencies {
  readonly repositories: AppsRepositories;
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
}

/**
 * Assembles the Apps control plane. The defaults here are what a Radioso that ships
 * without a hosted App runtime does: nothing provisions, nothing stages, nothing is
 * disposed, and a connection secret cannot be stored without a key. None of those are
 * product rules — each is the absence of an implementation, and the domain states what
 * the absence means.
 */
export const createAppsServices = (dependencies: AppsCompositionDependencies): AppsServices => {
  const { repositories, audit, logger } = dependencies;

  // A closure, not the service instance: a port method held as a value loses its
  // receiver, and this one is called from inside a durable saga.
  const authorization: AppOperatorAuthorizationPort = {
    requireAppAdministration: (principal, workspaceId) =>
      dependencies.accountAccessService.requirePermission({
        accountId: principal.accountId,
        userId: principal.userId,
        workspaceId,
        permission: APP_ADMINISTRATION_PERMISSION,
      }),
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
  });

  const appInstallationPlanService = new AppInstallationPlanService({
    releases: repositories.releases,
    installations: repositories.installations,
    connections: repositories.connections,
    plans: repositories.plans,
    authorization,
    audit,
  });

  const appInstallationLifecycleService = new AppInstallationLifecycleService({
    installations: repositories.installations,
    plans: repositories.plans,
    releases: repositories.releases,
    grants: repositories.grants,
    connections: repositories.connections,
    operations: repositories.operations,
    runtimeProvisioning: dependencies.runtimeProvisioning ?? createUnavailableAppRuntimeProvisioning(),
    contributionStaging: dependencies.contributionStaging ?? createNoopAppContributionStaging(),
    dataDisposition: dependencies.dataDisposition ?? createNoopAppManagedDataDisposition(),
    authorization,
    audit,
    logger,
  });

  const appInstallationQueryService = new AppInstallationQueryService({
    installations: repositories.installations,
    releases: repositories.releases,
    grants: repositories.grants,
    connections: repositories.connections,
    operations: repositories.operations,
    authorization,
    audit,
  });

  const appConnectionService = new AppConnectionService({
    installations: repositories.installations,
    releases: repositories.releases,
    connections: repositories.connections,
    cipher,
    authorization,
    audit,
  });

  return {
    appReleaseAdmissionService,
    appInstallationPlanService,
    appInstallationLifecycleService,
    appInstallationQueryService,
    appConnectionService,
  };
};
