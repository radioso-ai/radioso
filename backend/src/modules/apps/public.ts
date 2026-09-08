/**
 * The Apps control plane's only import surface. Everything else under
 * `src/modules/apps/` is internal: HTTP, composition, and other modules import from
 * here so the domain can be reshaped without a repository-wide edit.
 */
export { AppsError, type AppsErrorReason } from "./domain/errors.js";
export {
  APP_ADMISSION_POLICY_VERSION,
  admitAppRelease,
  appManifestDigest,
} from "./domain/releaseAdmission.js";
export { satisfiesSemanticVersionRange } from "./domain/semanticVersion.js";
export {
  APP_INSTALLATION_PLAN_TTL_MS,
  assertAppPlanApplicable,
  buildAppInstallationPlan,
} from "./domain/installationPlan.js";
export {
  appSagaCompensationPlan,
  appSagaSteps,
  assertAppInstallationTransition,
  canTransitionAppInstallation,
  remainingAppSagaCompensationSteps,
  remainingAppSagaSteps,
  type AppInstallationState,
} from "./domain/lifecycle.js";
export { buildAppConnectionBinding } from "./domain/connectionBinding.js";
export type {
  AppConnectionRecord,
  AppGrantRecord,
  AppInstallationRecord,
  AppInstallationPlanRecord,
  AppLifecycleOperationRecord,
  AppReleaseRecord,
} from "./domain/records.js";

export {
  createUnavailableAppRuntimeProvisioning,
  type AppRuntimeProvisioningPort,
} from "./ports/runtimeProvisioning.js";
export {
  createNoopAppContributionStaging,
  type AppContributionStagingPort,
} from "./ports/contributionStaging.js";
export {
  appDataDispositions,
  createNoopAppManagedDataDisposition,
  type AppManagedDataDispositionPort,
} from "./ports/managedDataDisposition.js";
export {
  createUnavailableAppSecretCipher,
  type AppSecretCipherPort,
} from "./ports/secretCipher.js";
export type {
  AppOperatorAuthorizationPort,
  AppOperatorPrincipal,
} from "./ports/operatorAuthorization.js";

export { AppReleaseRepository, type AppReleaseRepositoryPort } from "./repositories/appReleaseRepository.js";
export { AppInstallationRepository, type AppInstallationRepositoryPort } from "./repositories/appInstallationRepository.js";
export { AppInstallationPlanRepository, type AppInstallationPlanRepositoryPort } from "./repositories/appInstallationPlanRepository.js";
export { AppGrantRepository, type AppGrantRepositoryPort } from "./repositories/appGrantRepository.js";
export { AppConnectionRepository, type AppConnectionRepositoryPort } from "./repositories/appConnectionRepository.js";
export { AppLifecycleOperationRepository, type AppLifecycleOperationRepositoryPort } from "./repositories/appLifecycleOperationRepository.js";
export { AppAuditOutboxRepository, type AppAuditOutboxRepositoryPort } from "./repositories/appAuditOutboxRepository.js";
export type { AppsUnitOfWork } from "./repositories/appsUnitOfWork.js";

export {
  AppReleaseAdmissionService,
  type BuiltInAppRelease,
  type AppReleaseView,
} from "./services/appReleaseAdmissionService.js";
export { AppInstallationPlanService } from "./services/appInstallationPlanService.js";
export { AppConnectionService } from "./services/appConnectionService.js";
export { AppAuditOutboxDispatcher } from "./services/appAuditOutboxDispatcher.js";
export {
  AppInstallationLifecycleService,
  type AppLifecycleOutcome,
} from "./services/appInstallationLifecycleService.js";
export {
  AppInstallationQueryService,
  type AppInstallationView,
} from "./services/appInstallationQueryService.js";
/**
 * The fail-closed execution decision every runtime path asks before it grants authority
 * to a contribution. It is exported as a port so `appRuntime` and the contribution owners
 * depend on the question, not on Apps persistence.
 */
export {
  AppExecutionEligibilityService,
  type AppExecutionEligibilityPort,
} from "./services/appExecutionEligibilityService.js";
