import { resolveInstallation, type AdmittedManifest } from "@radioso/app-contract";

import { notFound } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import { requireAppAdministration } from "../domain/authorization.js";
import { AppsError } from "../domain/errors.js";
import {
  assertAppInstallationTransition,
  remainingAppSagaCompensationSteps,
  remainingAppSagaSteps,
  type AppInstallationState,
  type AppLifecycleOperationKind,
  type AppSagaStep,
} from "../domain/lifecycle.js";
import {
  appPlanBlockingRequirements,
  assertAppPlanApplicable,
  type AppInstallationPlan,
} from "../domain/installationPlan.js";
import {
  appPortFailure,
  appPortFailureAsError,
  type AppPortFailureCode,
  type AppPortResult,
} from "../domain/portOutcome.js";
import { assertAppReleaseEligible } from "../domain/releaseAdmission.js";
import type {
  AppInstallationRecord,
  AppLifecycleOperationRecord,
  AppReleaseRecord,
} from "../domain/records.js";
import type { AppContributionStagingPort } from "../ports/contributionStaging.js";
import type { AppDataDisposition, AppManagedDataDispositionPort } from "../ports/managedDataDisposition.js";
import type { AppOperatorAuthorizationPort, AppOperatorPrincipal } from "../ports/operatorAuthorization.js";
import type { AppLifecycleEffect, AppRuntimeProvisioningPort } from "../ports/runtimeProvisioning.js";
import type { AppConnectionRepositoryPort } from "../repositories/appConnectionRepository.js";
import type { AppInstallationPlanRepositoryPort } from "../repositories/appInstallationPlanRepository.js";
import type { AppInstallationRepositoryPort } from "../repositories/appInstallationRepository.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";
import type { AppLifecycleOperationRepositoryPort } from "../repositories/appLifecycleOperationRepository.js";
import type { AppsTransactionalRepositories, AppsUnitOfWork } from "../repositories/appsUnitOfWork.js";
import { appLifecycleRequestFingerprint } from "./appLifecycleFingerprint.js";

interface AppInstallationLifecycleDependencies {
  readonly installations: AppInstallationRepositoryPort;
  readonly plans: AppInstallationPlanRepositoryPort;
  readonly releases: AppReleaseRepositoryPort;
  readonly connections: AppConnectionRepositoryPort;
  readonly operations: AppLifecycleOperationRepositoryPort;
  readonly unitOfWork: AppsUnitOfWork;
  readonly runtimeProvisioning: AppRuntimeProvisioningPort;
  readonly contributionStaging: AppContributionStagingPort;
  readonly dataDisposition: AppManagedDataDispositionPort;
  readonly authorization: AppOperatorAuthorizationPort;
  readonly audit: Pick<AuditPort, "record">;
  readonly logger: AppLogger;
  /** The Radioso version this host runs, or `null` when it cannot be determined. */
  readonly runningRadiosoVersion: string | null;
  readonly clock?: () => Date;
}

interface ApplyAppInstallationPlanRequest {
  readonly workspaceId: string;
  readonly planId: string;
  readonly checksum: string;
  readonly expectedInstallationVersion: number | null;
  readonly idempotencyKey: string;
  readonly principal: AppOperatorPrincipal;
}

interface AppLifecycleCommandRequest {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly principal: AppOperatorPrincipal;
}

interface RemoveAppInstallationRequest extends AppLifecycleCommandRequest {
  readonly disposition: AppDataDisposition;
}

interface ReconfigureAppInstallationRequest extends AppLifecycleCommandRequest {
  readonly configuration: Readonly<Record<string, unknown>>;
}

export interface AppLifecycleOutcome {
  readonly installation: AppInstallationRecord;
  readonly operation: AppLifecycleOperationRecord;
}

const completionAuditEvent: Readonly<Record<AppLifecycleOperationKind, string>> = {
  install: "app.installation.installed",
  activate: "app.installation.activated",
  reconfigure: "app.installation.configuration_updated",
  disable: "app.installation.disabled",
  enable: "app.installation.enabled",
  remove: "app.installation.removed",
  dispose_data: "app.installation.removed",
};

/** Steps whose effect depends on the release still being eligible right now (FR-049c). */
const releaseBoundSteps = new Set(["provision_runtime", "stage_contributions", "run_safe_tests", "activate"]);

/** Thrown inside a step transaction when the compare-and-set shows another driver owns it. */
class OperationHandedOver extends Error {}

interface StepCommit {
  readonly installation: AppInstallationRecord;
  readonly operation: AppLifecycleOperationRecord;
  readonly audit: readonly AuditIntent[];
}

interface AuditIntent {
  readonly eventType: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * The durable half of the Apps control plane. Apply, activation, reconfiguration,
 * disable, enable, removal, and data disposition all run as the same saga over
 * `app_lifecycle_operations`: one operation per installation at a time, one driver per
 * operation, every step idempotent, and every database effect committed together with the
 * cursor that says it happened. Each step re-checks the initiating principal, so a
 * resumed operation cannot mint a new privileged effect on lapsed authority.
 */
export class AppInstallationLifecycleService {
  constructor(private readonly dependencies: AppInstallationLifecycleDependencies) {}

  private now(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }

  /**
   * Records what the operator approved and nothing else: the installation row, its grants,
   * and its effective configuration, all in one transaction with the plan's consumption
   * and the operation that owns them. No runtime is started here — the operator binds the
   * release's connections against this installation first, and `activate` is what goes
   * live.
   */
  async apply(request: ApplyAppInstallationPlanRequest): Promise<AppLifecycleOutcome> {
    await requireAppAdministration(this.dependencies.authorization, request.principal, request.workspaceId);

    const fingerprint = appLifecycleRequestFingerprint({
      workspaceId: request.workspaceId,
      installationId: null,
      kind: "install",
      planChecksum: request.checksum,
      disposition: null,
      configuration: null,
      expectedVersion: request.expectedInstallationVersion,
    });
    const replayed = await this.replayed(request.idempotencyKey, fingerprint);
    if (replayed) return this.resume(request.workspaceId, replayed);

    const planRecord = await this.dependencies.plans.findById(request.workspaceId, request.planId);
    if (!planRecord) throw notFound("App installation plan not found");
    const plan = planRecord.plan;

    const release = await this.dependencies.releases.findById(plan.releaseId);
    if (!release) throw notFound("App release not found");
    // FR-049c: the approval named an admission policy version and a release state; both
    // are re-established now, because a release can be revoked between review and apply.
    if (release.admissionPolicyVersion !== plan.admissionPolicyVersion) {
      throw new AppsError("release_not_eligible", "This release was re-admitted under a different policy since this plan was reviewed.", {
        admissionPolicyVersion: release.admissionPolicyVersion,
      });
    }
    assertAppReleaseEligible(release, this.dependencies.runningRadiosoVersion);

    const blocking = appPlanBlockingRequirements(plan);
    if (blocking.length > 0) {
      throw new AppsError("invalid_configuration", "This plan still has unresolved requirements.", {
        unresolvedRequirementCount: blocking.length,
      });
    }

    const bootstrap = await this.dependencies.unitOfWork.run(async (repositories) => {
      const existing = await repositories.installations.findLiveByAppId(request.workspaceId, plan.appId);
      if (existing) {
        throw new AppsError("installation_conflict", "This App is already installed in this workspace.", {
          installationId: existing.id,
        });
      }
      const claimable = await repositories.plans.findById(request.workspaceId, planRecord.id);
      if (!claimable) throw notFound("App installation plan not found");
      assertAppPlanApplicable({
        plan: claimable,
        submittedChecksum: request.checksum,
        expectedInstallationVersion: request.expectedInstallationVersion,
        currentInstallationVersion: null,
        now: this.now(),
      });
      if (!(await repositories.plans.consume(request.workspaceId, claimable.id, this.now()))) {
        throw new AppsError("plan_stale", "This plan has already been applied.", { cause: "consumed" });
      }

      const installation = await repositories.installations.create({
        workspaceId: request.workspaceId,
        appId: plan.appId,
        candidateReleaseId: plan.releaseId,
        configuration: plan.configuration,
      });
      const { operation } = await repositories.operations.start({
        installationId: installation.id,
        kind: "install",
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint,
        initiatedBy: request.principal,
        payload: { planId: planRecord.id, checksum: planRecord.checksum, releaseId: plan.releaseId },
      });
      return { installation, operation };
    });

    return this.drive(request.workspaceId, bootstrap.operation, bootstrap.installation, plan);
  }

  activate(request: AppLifecycleCommandRequest): Promise<AppLifecycleOutcome> {
    return this.command(request, "activate", {});
  }

  disable(request: AppLifecycleCommandRequest): Promise<AppLifecycleOutcome> {
    return this.command(request, "disable", {});
  }

  enable(request: AppLifecycleCommandRequest): Promise<AppLifecycleOutcome> {
    return this.command(request, "enable", {});
  }

  remove(request: RemoveAppInstallationRequest): Promise<AppLifecycleOutcome> {
    return this.command(request, "remove", { disposition: request.disposition }, request.disposition);
  }

  /**
   * FR-021b. A configuration change is a lifecycle operation, not a patch: it validates,
   * re-stages, re-tests, and only then becomes the installation's answer to what it does.
   */
  reconfigure(request: ReconfigureAppInstallationRequest): Promise<AppLifecycleOutcome> {
    return this.command(request, "reconfigure", { configuration: request.configuration }, null, request.configuration);
  }

  /**
   * Re-drives an operation left running or compensating by a crash. Safe to call
   * repeatedly: the cursors decide what is still owed, in whichever direction the
   * operation was travelling.
   */
  async resumeById(workspaceId: string, operationId: string): Promise<AppLifecycleOutcome> {
    const operation = await this.dependencies.operations.findById(operationId);
    if (!operation) throw notFound("App lifecycle operation not found");
    return this.resume(workspaceId, operation);
  }

  private async replayed(
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<AppLifecycleOperationRecord | null> {
    const existing = await this.dependencies.operations.findByIdempotencyKey(idempotencyKey);
    if (!existing) return null;
    if (existing.requestFingerprint !== fingerprint) {
      throw new AppsError(
        "idempotency_key_reused",
        "This idempotency key was already used for a different request. Use a new key.",
        { operationId: existing.id, operationKind: existing.kind },
      );
    }
    return existing;
  }

  private async command(
    request: AppLifecycleCommandRequest,
    kind: AppLifecycleOperationKind,
    payload: Readonly<Record<string, unknown>>,
    disposition: string | null = null,
    configuration: Readonly<Record<string, unknown>> | null = null,
  ): Promise<AppLifecycleOutcome> {
    await requireAppAdministration(this.dependencies.authorization, request.principal, request.workspaceId);

    const fingerprint = appLifecycleRequestFingerprint({
      workspaceId: request.workspaceId,
      installationId: request.installationId,
      kind,
      planChecksum: null,
      disposition,
      configuration,
      expectedVersion: request.expectedVersion,
    });
    const replayed = await this.replayed(request.idempotencyKey, fingerprint);
    if (replayed) return this.resume(request.workspaceId, replayed);

    if (kind === "activate") await this.assertRequiredConnectionsBound(request.workspaceId, request.installationId);

    const claimed = await this.dependencies.unitOfWork.run(async (repositories) => {
      const current = await repositories.installations.findById(request.workspaceId, request.installationId);
      if (!current) throw notFound("App installation not found");
      if (kind !== "remove" && kind !== "dispose_data" && (current.state === "removing" || current.state === "removed")) {
        throw new AppsError("installation_removing", "This installation is being removed.", { state: current.state });
      }
      // The operator approved an installation they had read. Binding that approval to the
      // version they saw is what stops a removal decided against version N from running
      // against a version N+1 somebody else produced in the meantime.
      const installation = await repositories.installations.update(
        request.workspaceId,
        current.id,
        request.expectedVersion,
        {},
      );
      if (!installation) {
        throw new AppsError("plan_stale", "This installation changed since it was read.", {
          cause: "version_mismatch",
        });
      }
      const { operation } = await repositories.operations.start({
        installationId: installation.id,
        kind,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint,
        initiatedBy: request.principal,
        payload,
      });
      return { installation, operation };
    });

    return this.drive(request.workspaceId, claimed.operation, claimed.installation, null);
  }

  /**
   * Never counts a slot as bound without a connection record (FR-031). A host-minted slot
   * is satisfied by the bind that mints it, not by the fact that the host could.
   */
  private async assertRequiredConnectionsBound(workspaceId: string, installationId: string): Promise<void> {
    const installation = await this.loadInstallation(workspaceId, installationId);
    const { manifest } = await this.releaseContextFor(installation);
    const resolved = resolveInstallation(manifest, installation.configuration);
    const required = resolved.ok ? resolved.readiness.requiredConnectionSlots : [];
    if (required.length === 0) return;
    const bound = new Set(
      (await this.dependencies.connections.listByInstallation(installation.id))
        .filter((connection) => connection.deletionRequestedAt === null)
        .map((connection) => connection.slotId),
    );
    const unbound = required.filter((slotId) => !bound.has(slotId));
    if (unbound.length > 0) {
      throw new AppsError(
        "connections_unbound",
        "This installation still needs a connection bound before it can be activated.",
        { slotIds: unbound.join(","), unboundCount: unbound.length },
      );
    }
  }

  private async resume(
    workspaceId: string,
    operation: AppLifecycleOperationRecord,
  ): Promise<AppLifecycleOutcome> {
    const installation = await this.loadInstallation(workspaceId, operation.installationId);
    const plan = typeof operation.payload.planId === "string"
      ? (await this.dependencies.plans.findById(workspaceId, operation.payload.planId))?.plan ?? null
      : null;
    return this.drive(workspaceId, operation, installation, plan);
  }

  private drive(
    workspaceId: string,
    operation: AppLifecycleOperationRecord,
    installation: AppInstallationRecord,
    plan: AppInstallationPlan | null,
  ): Promise<AppLifecycleOutcome> {
    if (operation.state === "compensating") {
      // A process that died mid-rollback left this record behind. Driving it forward
      // would re-provision and activate an installation whose grants and runtime were
      // already reversed, so it goes back to the reverse runner instead.
      return this.compensate(workspaceId, operation, installation, operation.error ?? {
        reason: "internal",
        message: "This operation was abandoned.",
      });
    }
    if (operation.state !== "running") return Promise.resolve({ installation, operation });
    return this.runForward(workspaceId, operation, installation, plan);
  }

  private async loadInstallation(workspaceId: string, installationId: string): Promise<AppInstallationRecord> {
    const installation = await this.dependencies.installations.findById(workspaceId, installationId);
    if (!installation) throw notFound("App installation not found");
    return installation;
  }

  private async runForward(
    workspaceId: string,
    startingOperation: AppLifecycleOperationRecord,
    startingInstallation: AppInstallationRecord,
    plan: AppInstallationPlan | null,
  ): Promise<AppLifecycleOutcome> {
    let operation = startingOperation;
    let installation = startingInstallation;

    for (const step of remainingAppSagaSteps(operation.kind, operation.step)) {
      // FR-027a/b. The check runs per step, not per request: a saga that resumes hours
      // later must not act on authority its initiator no longer holds.
      const decision = await this.dependencies.authorization
        .authorizeAppAdministration(operation.initiatedBy, workspaceId);
      if (!decision.ok && decision.outcome === "denied") {
        return this.abandon(workspaceId, operation, installation, new AppsError(
          "initiating_principal_unauthorized",
          "The operator who started this operation can no longer administer Apps in this workspace. A currently authorized operator must approve a new plan.",
        ));
      }
      if (!decision.ok) {
        // Indeterminate is not a revocation. The operation stays running at its cursor
        // with no new effect, and a later retry re-asks the same question (FR-027b).
        this.dependencies.logger.warn(
          { installationId: installation.id, operationId: operation.id, step: step.id },
          "App lifecycle step paused: App administration could not be checked",
        );
        throw new AppsError(
          "authorization_unavailable",
          "Radioso could not check App administration permission, so this operation is paused. Retry it in a moment.",
          { operationId: operation.id, step: step.id },
        );
      }

      let committed: StepCommit | null;
      try {
        const external = await this.runExternalEffect(step, workspaceId, installation, operation, plan);
        if (!external.ok) {
          this.logPortFailure(step, installation, operation, external.code, external.detail);
          return this.abandon(
            workspaceId,
            operation,
            installation,
            appPortFailureAsError(external.code, { step: step.id }),
          );
        }
        committed = await this.commitStep(step, workspaceId, installation, operation, plan);
      } catch (error) {
        return this.abandon(workspaceId, operation, installation, error);
      }

      if (!committed) {
        // Another driver advanced this operation. Stopping here is what keeps two
        // concurrent retries from running the same step twice.
        const current = await this.dependencies.operations.findById(operation.id);
        return { installation, operation: current ?? operation };
      }
      installation = committed.installation;
      operation = committed.operation;
      for (const intent of committed.audit) await this.emitAudit(workspaceId, operation, installation, intent);
    }

    operation = await this.dependencies.operations.update(operation.id, { state: "completed", error: null });
    await this.emitAudit(workspaceId, operation, installation, {
      eventType: completionAuditEvent[operation.kind],
      metadata: { state: installation.state, releaseId: installation.activeReleaseId },
    });
    return { installation, operation };
  }

  /**
   * Everything a step does outside the database, named by the one effect id an
   * implementation deduplicates on. Running this before the transaction is deliberate: an
   * external effect that lands and then loses its cursor is replayed with the same
   * `(operationId, stepId)` pair and must resolve to the same single effect.
   */
  private async runExternalEffect(
    step: AppSagaStep,
    workspaceId: string,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    plan: AppInstallationPlan | null,
  ): Promise<AppPortResult> {
    const effect: AppLifecycleEffect = { operationId: operation.id, stepId: step.id };
    const release = releaseBoundSteps.has(step.id) ? await this.releaseContextFor(installation) : null;

    try {
      switch (step.id) {
        case "provision_runtime":
          return await this.dependencies.runtimeProvisioning.provision({
            effect,
            installationId: installation.id,
            workspaceId,
            release: {
              digest: release!.record.manifestDigest,
              artifact: {
                digest: release!.manifest.artifact.digest,
                mediaType: release!.manifest.artifact.mediaType,
                entrypoint: release!.manifest.artifact.entrypoint ?? null,
              },
              resourceProfile: { ...release!.manifest.resourceProfile },
            },
          });
        case "stage_contributions":
          return await this.dependencies.contributionStaging.stage(
            this.stagingRequest(effect, installation, release!, operation, plan),
          );
        case "run_safe_tests":
          return await this.dependencies.contributionStaging.runSafeTests(
            this.stagingRequest(effect, installation, release!, operation, plan),
          );
        case "stop_runtime":
          return await this.dependencies.runtimeProvisioning.deprovision({ effect, installationId: installation.id });
        case "detach_contributions":
          return await this.dependencies.contributionStaging.detach({ effect, installationId: installation.id });
        case "dispose_data":
          return await this.dependencies.dataDisposition.dispose({
            effect,
            workspaceId,
            installationId: installation.id,
            disposition: readDisposition(operation.payload.disposition),
          });
        default:
          return { ok: true };
      }
    } catch (error) {
      // An adapter threw instead of answering. Its message is never read: it can carry a
      // token, a command line, or a response body, and this value reaches persisted
      // health and an operator's screen.
      this.logAdapterThrow(step, installation, operation, error);
      return appPortFailure("adapter_error");
    }
  }

  private stagingRequest(
    effect: AppLifecycleEffect,
    installation: AppInstallationRecord,
    release: { readonly record: AppReleaseRecord; readonly manifest: AdmittedManifest },
    operation: AppLifecycleOperationRecord,
    plan: AppInstallationPlan | null,
  ) {
    const configuration = operation.kind === "reconfigure"
      ? readConfiguration(operation.payload.configuration)
      : installation.configuration;
    const resolved = resolveInstallation(release.manifest, configuration);
    const contributionIds = resolved.ok
      ? resolved.readiness.activeContributionIds
      : plan?.contributions.filter((contribution) => contribution.active).map((contribution) => contribution.id) ?? [];
    return {
      effect,
      installationId: installation.id,
      releaseId: release.record.id,
      contributionIds: [...contributionIds],
    };
  }

  /**
   * Commits the step's database effects and its cursor together. When the compare-and-set
   * matches nothing the whole transaction rolls back, so a driver that lost the operation
   * leaves no half-written effect behind.
   */
  private async commitStep(
    step: AppSagaStep,
    workspaceId: string,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    plan: AppInstallationPlan | null,
  ): Promise<StepCommit | null> {
    try {
      return await this.dependencies.unitOfWork.run(async (repositories) => {
        const applied = await this.applyStepEffects(step, workspaceId, installation, operation, plan, repositories);
        const advanced = await repositories.operations.advance(operation.id, {
          expectedState: "running",
          expectedStep: operation.step,
          step: step.id,
        });
        if (!advanced) throw new OperationHandedOver();
        return { installation: applied.installation, operation: advanced, audit: applied.audit };
      });
    } catch (error) {
      if (error instanceof OperationHandedOver) return null;
      throw error;
    }
  }

  private async applyStepEffects(
    step: AppSagaStep,
    workspaceId: string,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    plan: AppInstallationPlan | null,
    repositories: AppsTransactionalRepositories,
  ): Promise<{ installation: AppInstallationRecord; audit: readonly AuditIntent[] }> {
    const audit: AuditIntent[] = [];
    let current = installation;

    switch (step.id) {
      case "persist_grants_and_connections": {
        if (plan) {
          await repositories.grants.approve({
            installationId: current.id,
            releaseId: plan.releaseId,
            planId: typeof operation.payload.planId === "string" ? operation.payload.planId : null,
            approvedBy: operation.initiatedBy.userId,
            grants: plan.grants,
          });
          audit.push({
            eventType: "app.grant.approved",
            metadata: { releaseId: plan.releaseId, grantCount: plan.grants.length },
          });
        }
        break;
      }
      case "validate": {
        await this.validateReconfiguration(current, operation);
        break;
      }
      case "apply_configuration": {
        const manifest = (await this.releaseContextFor(current)).manifest;
        const resolved = resolveInstallation(manifest, readConfiguration(operation.payload.configuration));
        if (!resolved.ok) {
          const [issue] = resolved.issues;
          throw new AppsError("invalid_configuration", issue?.message ?? "Configuration is invalid.", {
            field: issue?.path ?? "configuration",
          });
        }
        current = await this.write(repositories, workspaceId, current, { configuration: resolved.configuration });
        audit.push({
          eventType: "app.installation.configuration_changed",
          // Keys only: a configuration value can be a site URL or a customer identifier.
          metadata: { configurationKeys: Object.keys(resolved.configuration).sort() },
        });
        break;
      }
      case "activate": {
        current = await this.write(repositories, workspaceId, current, {
          state: "active",
          activeReleaseId: current.candidateReleaseId ?? current.activeReleaseId,
          candidateReleaseId: null,
        });
        return { installation: current, audit };
      }
      case "revoke_grants": {
        const revoked = await repositories.grants.revokeAll(current.id, this.now());
        audit.push({ eventType: "app.grant.revoked", metadata: { grantCount: revoked } });
        break;
      }
      case "mark_connections_for_deletion": {
        const marked = await repositories.connections.markAllForDeletion(current.id, this.now());
        audit.push({ eventType: "app.connection.revoked", metadata: { connectionCount: marked } });
        break;
      }
      default:
        break;
    }

    if (step.enters !== null) current = await this.write(repositories, workspaceId, current, { state: step.enters });
    return { installation: current, audit };
  }

  /** Validation for a reconfigure, run as its own step so a resume re-establishes it. */
  private async validateReconfiguration(
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
  ): Promise<void> {
    const { manifest } = await this.releaseContextFor(installation);
    const submitted = readConfiguration(operation.payload.configuration);
    const resolved = resolveInstallation(manifest, submitted);
    if (!resolved.ok) {
      const [issue] = resolved.issues;
      throw new AppsError("invalid_configuration", issue?.message ?? "Configuration is invalid.", {
        field: issue?.path ?? "configuration",
      });
    }

    // Configuration decides which contributions run, so a value change can turn one on.
    // Only what this change newly requires is checked: a slot that was already required
    // and already unbound is the installation's existing state, not something this edit
    // introduced, and refusing here would make an unrelated edit impossible.
    const stored = resolveInstallation(manifest, installation.configuration);
    const alreadyRequired = new Set(stored.ok ? stored.readiness.requiredConnectionSlots : []);
    const newlyRequired = resolved.readiness.requiredConnectionSlots
      .filter((slotId) => !alreadyRequired.has(slotId));
    if (newlyRequired.length === 0) return;

    const bound = new Set(
      (await this.dependencies.connections.listByInstallation(installation.id))
        .filter((connection) => connection.deletionRequestedAt === null)
        .map((connection) => connection.slotId),
    );
    const unbound = newlyRequired.filter((slotId) => !bound.has(slotId));
    if (unbound.length > 0) {
      throw new AppsError(
        "connection_unbound",
        "This change turns on a contribution whose connection is not bound yet.",
        { slotId: unbound[0] ?? "" },
      );
    }
  }

  private async write(
    repositories: AppsTransactionalRepositories,
    workspaceId: string,
    installation: AppInstallationRecord,
    mutation: {
      state?: AppInstallationState;
      activeReleaseId?: string | null;
      candidateReleaseId?: string | null;
      configuration?: Readonly<Record<string, unknown>>;
    },
  ): Promise<AppInstallationRecord> {
    if (mutation.state !== undefined) assertAppInstallationTransition(installation.state, mutation.state);
    const updated = await repositories.installations.update(
      workspaceId,
      installation.id,
      installation.version,
      mutation,
    );
    if (!updated) {
      throw new AppsError("plan_stale", "The installation changed while this operation was running.", {
        cause: "version_mismatch",
      });
    }
    return updated;
  }

  /** The release this installation is acting on, re-established as currently eligible. */
  private async releaseContextFor(
    installation: AppInstallationRecord,
  ): Promise<{ record: AppReleaseRecord; manifest: AdmittedManifest }> {
    const releaseId = installation.candidateReleaseId ?? installation.activeReleaseId;
    const record = releaseId ? await this.dependencies.releases.findById(releaseId) : null;
    if (!record) throw notFound("App release not found");
    return { record, manifest: assertAppReleaseEligible(record, this.dependencies.runningRadiosoVersion) };
  }

  /**
   * Compensates what committed, in reverse, then records the failure. Compensation is
   * system-owned safety work and runs even when the initiating principal has lost access.
   */
  private async abandon(
    workspaceId: string,
    operation: AppLifecycleOperationRecord,
    installation: AppInstallationRecord,
    error: unknown,
  ): Promise<AppLifecycleOutcome> {
    const failure = failureOf(error);
    const compensating = await this.dependencies.operations.update(operation.id, {
      state: "compensating",
      error: failure,
    });
    return this.compensate(workspaceId, compensating, installation, failure);
  }

  private async compensate(
    workspaceId: string,
    startingOperation: AppLifecycleOperationRecord,
    startingInstallation: AppInstallationRecord,
    failure: { readonly reason: string; readonly message: string },
  ): Promise<AppLifecycleOutcome> {
    let operation = startingOperation;
    let installation = startingInstallation;
    let cursor = operation.compensationStep;

    for (const step of remainingAppSagaCompensationSteps(operation.kind, operation.step, cursor)) {
      const result = await this.compensateStep(step, installation, operation, cursor);
      if (!result.ok) {
        this.logPortFailure(step, installation, operation, result.code, result.detail);
        // The cursor is persisted before the operation becomes terminal, so an operator
        // reading a `compensation_failed` record can see exactly how far rollback got.
        await this.dependencies.operations.update(operation.id, { compensationStep: cursor });
        const stopped = await this.dependencies.operations.update(operation.id, {
          state: "compensation_failed",
          error: {
            reason: failure.reason,
            message: `${failure.message} Rolling this operation back did not finish; an operator needs to review this installation.`,
          },
        });
        installation = await this.markFailed(workspaceId, installation, failure);
        await this.emitAudit(workspaceId, stopped, installation, {
          eventType: "app.installation.failed",
          metadata: { step: stopped.step, compensationStep: cursor, reason: failure.reason, compensated: false },
        });
        return { installation, operation: stopped };
      }
      if (result.operation === null) {
        const current = await this.dependencies.operations.findById(operation.id);
        return { installation, operation: current ?? operation };
      }
      operation = result.operation;
      installation = result.installation;
      cursor = step.id;
    }

    installation = await this.markFailed(workspaceId, installation, failure);
    const finished = await this.dependencies.operations.update(operation.id, {
      state: "failed",
      error: failure,
    });
    this.dependencies.logger.warn(
      {
        installationId: installation.id,
        operationId: finished.id,
        operationKind: finished.kind,
        reason: failure.reason,
      },
      "App lifecycle operation failed",
    );
    await this.emitAudit(workspaceId, finished, installation, {
      eventType: "app.installation.failed",
      metadata: { step: finished.step, reason: failure.reason, compensated: true },
    });
    return { installation, operation: finished };
  }

  private async compensateStep(
    step: AppSagaStep,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    cursor: AppLifecycleOperationRecord["compensationStep"],
  ): Promise<
    | { ok: true; operation: AppLifecycleOperationRecord | null; installation: AppInstallationRecord }
    | { ok: false; code: AppPortFailureCode; detail?: string }
  > {
    const effect: AppLifecycleEffect = { operationId: operation.id, stepId: `compensate:${step.id}` };
    const advance = async (): Promise<AppLifecycleOperationRecord | null> =>
      this.dependencies.operations.advanceCompensation(operation.id, {
        expectedCompensationStep: cursor,
        compensationStep: step.id,
      });

    try {
      switch (step.id) {
        case "persist_grants_and_connections": {
          const advanced = await this.dependencies.unitOfWork.run(async (repositories) => {
            await repositories.grants.revokeAll(installation.id, this.now());
            const next = await repositories.operations.advanceCompensation(operation.id, {
              expectedCompensationStep: cursor,
              compensationStep: step.id,
            });
            if (!next) throw new OperationHandedOver();
            return next;
          }).catch((error: unknown) => {
            if (error instanceof OperationHandedOver) return null;
            throw error;
          });
          return { ok: true, operation: advanced, installation };
        }
        case "provision_runtime": {
          const result = await this.dependencies.runtimeProvisioning
            .deprovision({ effect, installationId: installation.id });
          if (!result.ok) return result;
          return { ok: true, operation: await advance(), installation };
        }
        case "stage_contributions": {
          const result = await this.dependencies.contributionStaging
            .detach({ effect, installationId: installation.id });
          if (!result.ok) return result;
          return { ok: true, operation: await advance(), installation };
        }
        default:
          return { ok: true, operation: await advance(), installation };
      }
    } catch (error) {
      this.logAdapterThrow(step, installation, operation, error);
      return appPortFailure("adapter_error");
    }
  }

  private async markFailed(
    workspaceId: string,
    installation: AppInstallationRecord,
    failure: { readonly reason: string; readonly message: string },
  ): Promise<AppInstallationRecord> {
    if (installation.state === "removed" || installation.state === "failed") return installation;
    const failed = await this.dependencies.installations.update(
      workspaceId,
      installation.id,
      installation.version,
      { state: "failed", health: { reason: failure.reason, message: failure.message } },
    );
    return failed ?? installation;
  }

  /**
   * Audit is a record of what happened, not a step of it. A sink that is down must not
   * roll back a runtime that is already running or leave an operation neither completed
   * nor failed, so a failure here is a structured warning and the saga continues. That is
   * the Release A posture; a delivery guarantee belongs with the outbox, not here.
   */
  private async emitAudit(
    workspaceId: string,
    operation: AppLifecycleOperationRecord,
    installation: AppInstallationRecord,
    intent: AuditIntent,
  ): Promise<void> {
    try {
      await this.dependencies.audit.record({
        accountId: operation.initiatedBy.accountId,
        workspaceId,
        eventType: intent.eventType,
        eventStatus: intent.eventType.endsWith(".failed") ? "failure" : "success",
        metadata: {
          installationId: installation.id,
          appId: installation.appId,
          operationId: operation.id,
          operationKind: operation.kind,
          // FR-064: which administrator this was, not merely which account.
          actorUserId: operation.initiatedBy.userId,
          ...intent.metadata,
        },
      });
    } catch (error) {
      this.dependencies.logger.warn(
        {
          installationId: installation.id,
          operationId: operation.id,
          eventType: intent.eventType,
          err: errorIdentity(error),
        },
        "App lifecycle audit event was not recorded",
      );
    }
  }

  private logPortFailure(
    step: AppSagaStep,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    code: string,
    detail?: string,
  ): void {
    this.dependencies.logger.warn(
      {
        installationId: installation.id,
        operationId: operation.id,
        operationKind: operation.kind,
        step: step.id,
        code,
        ...(detail === undefined ? {} : { detail }),
      },
      "App lifecycle step refused by a platform port",
    );
  }

  private logAdapterThrow(
    step: AppSagaStep,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    error: unknown,
  ): void {
    this.dependencies.logger.error(
      {
        installationId: installation.id,
        operationId: operation.id,
        step: step.id,
        err: errorIdentity(error),
      },
      "App lifecycle adapter threw instead of reporting a typed result",
    );
  }
}

/** Identity only. An adapter's message can carry a secret, so it is never logged. */
const errorIdentity = (error: unknown): { name: string; code?: string } => {
  if (!error || typeof error !== "object") return { name: "unknown" };
  const candidate = error as { name?: unknown; code?: unknown };
  return {
    name: typeof candidate.name === "string" ? candidate.name : "unknown",
    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
  };
};

/**
 * The one place a failure becomes text. An `AppsError` carries a message written in this
 * repository; anything else contributes only the fact that it failed.
 */
const failureOf = (error: unknown): { reason: string; message: string } =>
  error instanceof AppsError
    ? { reason: error.reason, message: error.message }
    : { reason: "internal", message: "This App lifecycle operation could not be completed." };

const readDisposition = (value: unknown): AppDataDisposition =>
  value === "export" || value === "delete" ? value : "retain";

const readConfiguration = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
