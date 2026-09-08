import { AppError } from "../../../shared/domain/errors.js";
import {
  AppsError,
  type AppConnectionRecord,
  type AppGrantRecord,
  type AppInstallationPlanRecord,
  type AppInstallationRecord,
  type AppInstallationView,
  type AppLifecycleOperationRecord,
  type AppReleaseRecord,
  type AppsErrorReason,
} from "../../../modules/apps/public.js";

/**
 * The status each refusal deserves. The domain names the reason; only transport decides
 * what an HTTP client should do about it, which is why the map lives here.
 */
const statusByReason: Readonly<Record<AppsErrorReason, number>> = {
  invalid_configuration: 400,
  connection_invalid: 400,
  connection_slot_unknown: 400,
  connection_unbound: 409,
  connections_unbound: 409,
  connection_encryption_unavailable: 503,
  plan_stale: 409,
  invalid_transition: 409,
  installation_conflict: 409,
  installation_removing: 409,
  operation_in_progress: 409,
  idempotency_key_reused: 409,
  runtime_unavailable: 503,
  staging_unavailable: 503,
  safe_test_failed: 409,
  data_disposition_unavailable: 503,
  initiating_principal_unauthorized: 403,
  // The platform could not establish whether this operator may administer Apps. That is
  // a temporary platform condition, not a statement about the operator, so it invites a
  // retry rather than telling them they lost access.
  authorization_unavailable: 503,
  release_not_eligible: 409,
  // A stored release that no longer passes its own recorded admission policy is
  // stored-state corruption, not a client mistake, so this is a 500 rather than a 409.
  release_not_admitted: 500,
};

/** Leaves every other error untouched so the shared handler keeps owning it. */
export const presentAppsError = (error: unknown): unknown =>
  error instanceof AppsError
    ? new AppError(statusByReason[error.reason], error.reason, error.message, error.details)
    : error;

export const presentAppRelease = (release: AppReleaseRecord) => ({
  id: release.id,
  appId: release.appId,
  version: release.version,
  name: release.manifest.app.name,
  description: release.manifest.app.description,
  publisher: release.manifest.app.publisher,
  manifestDigest: release.manifestDigest,
  artifactDigest: release.artifactDigest,
  admissionPolicyVersion: release.admissionPolicyVersion,
  admittedAt: release.updatedAt.toISOString(),
});

/**
 * Inspection carries the admitted manifest itself rather than a projection of it. The
 * manifest is the document the operator is being asked to approve, it holds no secret,
 * and re-describing its fields here would be a second copy of the contract package's
 * schema that drifts the moment a field is added.
 */
export const presentAppReleaseDetail = (release: AppReleaseRecord) => ({
  ...presentAppRelease(release),
  manifest: release.manifest,
});

export const presentAppInstallation = (installation: AppInstallationRecord) => ({
  id: installation.id,
  appId: installation.appId,
  state: installation.state,
  activeReleaseId: installation.activeReleaseId,
  candidateReleaseId: installation.candidateReleaseId,
  configuration: installation.configuration,
  health: installation.health,
  version: installation.version,
  createdAt: installation.createdAt.toISOString(),
  updatedAt: installation.updatedAt.toISOString(),
});

const presentGrant = (grant: AppGrantRecord) => ({
  kind: grant.kind,
  key: grant.key,
  releaseId: grant.releaseId,
  approvedAt: grant.approvedAt.toISOString(),
});

/** Identity and shape only: no ciphertext, no key id, and no field value. */
export const presentAppConnection = (connection: AppConnectionRecord) => ({
  id: connection.id,
  slotId: connection.slotId,
  kind: connection.kind,
  publicFields: connection.publicFields,
  hasSecret: connection.hasSecret,
  createdAt: connection.createdAt.toISOString(),
  updatedAt: connection.updatedAt.toISOString(),
  rotatedAt: connection.rotatedAt?.toISOString() ?? null,
  deletionRequestedAt: connection.deletionRequestedAt?.toISOString() ?? null,
});

export const presentAppLifecycleOperation = (operation: AppLifecycleOperationRecord) => ({
  id: operation.id,
  installationId: operation.installationId,
  kind: operation.kind,
  state: operation.state,
  step: operation.step,
  compensationStep: operation.compensationStep,
  // A reason code and a static message written in this repository. An adapter's own
  // exception text never reaches here.
  error: operation.error,
  createdAt: operation.createdAt.toISOString(),
  updatedAt: operation.updatedAt.toISOString(),
});

export const presentAppInstallationView = (view: AppInstallationView) => ({
  installation: presentAppInstallation(view.installation),
  activeVersion: view.activeVersion,
  candidateVersion: view.candidateVersion,
  grants: view.grants.map(presentGrant),
  connections: view.connections.map(presentAppConnection),
  currentOperation: view.currentOperation ? presentAppLifecycleOperation(view.currentOperation) : null,
});

export const presentAppInstallationPlan = (record: AppInstallationPlanRecord) => ({
  id: record.id,
  releaseId: record.releaseId,
  checksum: record.checksum,
  plan: record.plan,
  createdAt: record.createdAt.toISOString(),
  expiresAt: record.expiresAt.toISOString(),
  consumedAt: record.consumedAt?.toISOString() ?? null,
});

export const presentAppLifecycleOutcome = (outcome: {
  installation: AppInstallationRecord;
  operation: AppLifecycleOperationRecord;
}) => ({
  installation: presentAppInstallation(outcome.installation),
  operation: presentAppLifecycleOperation(outcome.operation),
});
