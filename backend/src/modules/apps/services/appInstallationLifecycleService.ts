import { randomUUID } from "node:crypto";

import { resolveInstallation, type AdmittedManifest } from "@radioso/app-contract";

import { notFound } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { requireAppAdministration } from "../domain/authorization.js";
import { appContributionDescriptors } from "../domain/contributionDescriptor.js";
import { AppsError } from "../domain/errors.js";
import {
  assertAppCommandSourceState,
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
  assertAppPlanIntegrity,
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
import type { AppContributionStagingPort, AppContributionStagingRequest } from "../ports/contributionStaging.js";
import type { AppDataDisposition, AppManagedDataDispositionPort } from "../ports/managedDataDisposition.js";
import type { AppOperatorAuthorizationPort, AppOperatorPrincipal } from "../ports/operatorAuthorization.js";
import type { AppLifecycleEffect, AppRuntimeProvisioningPort } from "../ports/runtimeProvisioning.js";
import type { AppAuditIntent } from "../repositories/appAuditOutboxRepository.js";
import type { AppConnectionRepositoryPort } from "../repositories/appConnectionRepository.js";
import type { AppInstallationPlanRepositoryPort } from "../repositories/appInstallationPlanRepository.js";
import type { AppInstallationRepositoryPort } from "../repositories/appInstallationRepository.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";
import type { AppLifecycleOperationRepositoryPort } from "../repositories/appLifecycleOperationRepository.js";
import type { AppsTransactionalRepositories, AppsUnitOfWork } from "../repositories/appsUnitOfWork.js";
import { appLifecycleRequestFingerprint } from "./appLifecycleFingerprint.js";

/**
 * How long a driver's claim on a step lasts. It bounds how long a crashed driver keeps an
 * operation to itself, so it has to outlast a slow provider call and still be short enough
 * that recovery is not an outage.
 */
const STEP_LEASE_MS = 5 * 60_000;

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
  /** Delivers the audit intents this service commits. Never a step of the saga. */
  readonly auditDelivery: { drain(): Promise<number> };
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
const releaseBoundSteps = new Set([
  "provision_runtime",
  "stage_contributions",
  "run_safe_tests",
  "persist_grants_and_connections",
  "activate",
]);

/**
 * A reconfigure that fails leaves the installation exactly as it was. The proposal was
 * staged as a candidate and never adopted, so the configuration that is still running is
 * still correct — marking the installation `failed` would stop a working App because of a
 * typo in an edit.
 */
const kindsThatPreserveTheInstallation = new Set<AppLifecycleOperationKind>(["reconfigure"]);

/** Thrown inside a claim transaction when the request turns out to be a retry of one already open. */
class ReplayExistingOperation extends Error {
  constructor(readonly operationId: string) {
    super("replay");
  }
}

interface StepCommit {
  readonly installation: AppInstallationRecord;
  readonly operation: AppLifecycleOperationRecord;
}

interface AppReleaseContext {
  readonly record: AppReleaseRecord;
  readonly manifest: AdmittedManifest;
}

/**
 * The durable half of the Apps control plane. Apply, activation, reconfiguration,
 * disable, enable, removal, and data disposition all run as the same saga over
 * `app_lifecycle_operations`: one operation per installation at a time, one leaseholder per
 * step, every step idempotent, and every database effect — including the audit intent —
 * committed together with the cursor that says it happened. Each step re-checks the
 * initiating principal, so a resumed operation cannot mint a new privileged effect on
 * lapsed authority.
 */
export class AppInstallationLifecycleService {
  constructor(private readonly dependencies: AppInstallationLifecycleDependencies) {}

  private now(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }

  private leaseExpiry(): Date {
    return new Date(this.now().getTime() + STEP_LEASE_MS);
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
      // Two plans can describe identical content; only the id says which approval this is.
      planId: request.planId,
      planChecksum: request.checksum,
      disposition: null,
      configuration: null,
      expectedVersion: request.expectedInstallationVersion,
    });

    const planRecord = await this.dependencies.plans.findById(request.workspaceId, request.planId);
    if (!planRecord) throw notFound("App installation plan not found");
    // The stored document has to still be the document its checksum names before any rule
    // reads it: a hand-edited row must not be applied as though an operator approved it.
    assertAppPlanIntegrity(planRecord);
    const plan = planRecord.plan;

    const release = await this.dependencies.releases.findById(plan.releaseId);
    if (!release) throw notFound("App release not found");
    // FR-049c: the approval named an admission policy version and a release state; both
    // are re-established now, and again inside the transaction that consumes the plan,
    // because a release can be revoked between review and apply.
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

    const now = this.now();
    const bootstrap = await this.claiming(async (repositories) => {
      const replayed = await repositories.operations
        .findByIdempotencyKey(request.workspaceId, request.idempotencyKey);
      if (replayed) throw this.replayOrRefuse(replayed, fingerprint);

      const existing = await repositories.installations.findLiveByAppId(request.workspaceId, plan.appId);
      if (existing) {
        throw new AppsError("installation_conflict", "This App is already installed in this workspace.", {
          installationId: existing.id,
        });
      }
      assertAppPlanApplicable({
        plan: planRecord,
        submittedChecksum: request.checksum,
        expectedInstallationVersion: request.expectedInstallationVersion,
        currentInstallationVersion: null,
        now,
      });

      // One statement, one instant: unconsumed, unexpired, still the approved checksum, and
      // still joined to a release admission has not withdrawn.
      const consumed = await repositories.plans.consume({
        workspaceId: request.workspaceId,
        planId: planRecord.id,
        checksum: request.checksum,
        releaseId: plan.releaseId,
        admissionPolicyVersion: plan.admissionPolicyVersion,
        manifestDigest: plan.manifestDigest,
        now,
      });
      if (!consumed) {
        const current = await repositories.releases.findById(plan.releaseId);
        if (!current) throw notFound("App release not found");
        assertAppReleaseEligible(current, this.dependencies.runningRadiosoVersion);
        throw new AppsError("plan_stale", "This plan has already been applied.", { cause: "consumed" });
      }

      const installation = await repositories.installations.create({
        workspaceId: request.workspaceId,
        appId: plan.appId,
        candidateReleaseId: plan.releaseId,
        configuration: plan.configuration,
      });
      const operation = await repositories.operations.reserve({
        workspaceId: request.workspaceId,
        installationId: installation.id,
        kind: "install",
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint,
        initiatedBy: request.principal,
        payload: { planId: planRecord.id, checksum: planRecord.checksum, releaseId: plan.releaseId },
      });
      if (!operation) {
        const raced = await repositories.operations
          .findByIdempotencyKey(request.workspaceId, request.idempotencyKey);
        if (!raced) throw new AppsError("plan_stale", "This apply could not be claimed.", { cause: "raced" });
        // Everything above rolls back with this throw, so the losing retry leaves no
        // consumed plan and no orphan installation behind.
        throw this.replayOrRefuse(raced, fingerprint);
      }
      return { installation, operation };
    });

    if (bootstrap.value === null) return this.resumeById(request.workspaceId, bootstrap.replayOf);
    return this.drive(request.workspaceId, bootstrap.value.operation, bootstrap.value.installation, plan);
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
   * stages the proposal as a candidate beside the configuration that is still running,
   * re-tests, and only then adopts it.
   */
  reconfigure(request: ReconfigureAppInstallationRequest): Promise<AppLifecycleOutcome> {
    return this.command(request, "reconfigure", { configuration: request.configuration }, null, request.configuration);
  }

  /**
   * Re-drives an operation left running or compensating by a crash. Safe to call
   * repeatedly: the cursors decide what is still owed, in whichever direction the
   * operation was travelling, and the lease decides who owes it.
   */
  async resumeById(workspaceId: string, operationId: string): Promise<AppLifecycleOutcome> {
    const operation = await this.dependencies.operations.findById(operationId);
    if (!operation) throw notFound("App lifecycle operation not found");
    if (operation.workspaceId !== workspaceId) throw notFound("App lifecycle operation not found");
    const installation = await this.loadInstallation(workspaceId, operation.installationId);
    const plan = typeof operation.payload.planId === "string"
      ? (await this.dependencies.plans.findById(workspaceId, operation.payload.planId))?.plan ?? null
      : null;
    return this.drive(workspaceId, operation, installation, plan);
  }

  /**
   * Runs a claim transaction and separates its two outcomes: a claim that succeeded, and a
   * request that turned out to be a retry of an operation already open. The second rolls
   * the transaction back, because a losing retry must leave nothing behind.
   */
  private async claiming<T>(
    work: (repositories: AppsTransactionalRepositories) => Promise<T>,
  ): Promise<{ value: T; replayOf: null } | { value: null; replayOf: string }> {
    try {
      return { value: await this.dependencies.unitOfWork.run(work), replayOf: null };
    } catch (error) {
      if (error instanceof ReplayExistingOperation) return { value: null, replayOf: error.operationId };
      throw error;
    }
  }

  /**
   * An idempotency key answers "is this the same attempt"; the fingerprint answers "at the
   * same thing". A match replays; a mismatch is refused, and the refusal names nothing
   * about the other operation but its id, because the two requests may not belong to the
   * same person.
   */
  private replayOrRefuse(existing: AppLifecycleOperationRecord, fingerprint: string): Error {
    if (existing.requestFingerprint === fingerprint) return new ReplayExistingOperation(existing.id);
    return new AppsError(
      "idempotency_key_reused",
      "This idempotency key was already used for a different request. Use a new key.",
      { operationId: existing.id },
    );
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
      planId: null,
      planChecksum: null,
      disposition,
      configuration,
      expectedVersion: request.expectedVersion,
    });

    if (kind === "activate") await this.assertRequiredConnectionsBound(request.workspaceId, request.installationId);

    const now = this.now();
    const claimed = await this.claiming(async (repositories) => {
      const replayed = await repositories.operations
        .findByIdempotencyKey(request.workspaceId, request.idempotencyKey);
      if (replayed) throw this.replayOrRefuse(replayed, fingerprint);

      const current = await repositories.installations.findById(request.workspaceId, request.installationId);
      if (!current) throw notFound("App installation not found");

      const repair = await this.admitRepair(repositories, current.id, kind);

      // What a command may be issued against is decided here, before any port is called.
      // Provisioning first and discovering the transition afterwards costs a compensation
      // and can fail a healthy installation.
      assertAppCommandSourceState(kind, current.state);

      const operation = await repositories.operations.reserve({
        workspaceId: request.workspaceId,
        installationId: current.id,
        kind,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint,
        initiatedBy: request.principal,
        payload: { ...payload, ...(repair ? { repair } : {}) },
      });
      if (!operation) {
        const raced = await repositories.operations
          .findByIdempotencyKey(request.workspaceId, request.idempotencyKey);
        if (!raced) throw new AppsError("plan_stale", "This command could not be claimed.", { cause: "raced" });
        throw this.replayOrRefuse(raced, fingerprint);
      }

      // The operator approved an installation they had read. Binding that approval to the
      // version they saw is what stops a removal decided against version N from running
      // against a version N+1 somebody else produced in the meantime. Teardown also closes
      // the execution gate here, in its first transaction, so nothing new is admitted while
      // the runtime is being stopped.
      const installation = await repositories.installations.update(
        request.workspaceId,
        current.id,
        request.expectedVersion,
        (kind === "disable" || kind === "remove") ? { executionDeniedAt: now } : {},
      );
      if (!installation) {
        throw new AppsError("plan_stale", "This installation changed since it was read.", {
          cause: "version_mismatch",
        });
      }
      return { installation, operation };
    });

    if (claimed.value === null) return this.resumeById(request.workspaceId, claimed.replayOf);
    return this.drive(request.workspaceId, claimed.value.operation, claimed.value.installation, null);
  }

  /**
   * A rollback that could not finish keeps its installation fenced: a runtime may still be
   * alive under a known effect id, so admitting a fresh `activate` would start a second
   * one. Removal is the repair, and it inherits that effect id so the provider it talks to
   * recognises what it is being asked to tear down.
   */
  private async admitRepair(
    repositories: AppsTransactionalRepositories,
    installationId: string,
    kind: AppLifecycleOperationKind,
  ): Promise<{ operationId: string; stepId: string } | null> {
    const holding = await repositories.operations.findActiveByInstallation(installationId);
    if (holding?.state !== "compensation_failed") return null;
    if (kind !== "remove") {
      throw new AppsError(
        "operation_in_progress",
        "This installation's rollback did not finish, so only removal can repair it.",
        { operationId: holding.id },
      );
    }
    const resolved = await repositories.operations.finish(holding.id, {
      expectedState: "compensation_failed",
      expectedStep: holding.step,
      leaseOwner: holding.leaseOwner ?? "",
      state: "failed",
      error: holding.error,
    });
    if (!resolved) {
      throw new AppsError(
        "operation_in_progress",
        "This installation's unfinished rollback changed while it was being repaired. Retry.",
        { operationId: holding.id },
      );
    }
    return { operationId: holding.id, stepId: "compensate:provision_runtime" };
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
      return this.compensate(workspaceId, operation, installation, randomUUID(), operation.error ?? {
        reason: "internal",
        message: "This operation was abandoned.",
      });
    }
    if (operation.state === "compensation_failed") {
      // Not resumable, and not free either. An operator removes the installation, which is
      // the repair path, and that is the only command `command()` will admit.
      this.dependencies.logger.warn(
        { installationId: installation.id, operationId: operation.id, operationKind: operation.kind },
        "App installation needs repair: a rollback did not finish",
      );
      return Promise.resolve({ installation, operation });
    }
    if (operation.state !== "running") return Promise.resolve({ installation, operation });
    return this.runForward(workspaceId, operation, installation, plan);
  }

  private async loadInstallation(workspaceId: string, installationId: string): Promise<AppInstallationRecord> {
    const installation = await this.dependencies.installations.findById(workspaceId, installationId);
    if (!installation) throw notFound("App installation not found");
    return installation;
  }

  /** Another driver owns this operation. Report what it currently is, and change nothing. */
  private async handedOver(
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
  ): Promise<AppLifecycleOutcome> {
    const current = await this.dependencies.operations.findById(operation.id);
    return { installation, operation: current ?? operation };
  }

  private async runForward(
    workspaceId: string,
    startingOperation: AppLifecycleOperationRecord,
    startingInstallation: AppInstallationRecord,
    plan: AppInstallationPlan | null,
  ): Promise<AppLifecycleOutcome> {
    let operation = startingOperation;
    let installation = startingInstallation;
    const leaseOwner = randomUUID();

    for (const step of remainingAppSagaSteps(operation.kind, operation.step)) {
      // The claim is what makes one driver the only one that can act on this step. It
      // happens before the port call, so a second driver never reaches the effect and can
      // never conclude from its own transient failure that the first driver's work should
      // be rolled back.
      const claimed = await this.dependencies.operations.claim(operation.id, {
        expectedState: "running",
        expectedStep: operation.step,
        leaseOwner,
        leaseExpiresAt: this.leaseExpiry(),
        now: this.now(),
      });
      if (!claimed) return this.handedOver(installation, operation);
      operation = claimed;

      // FR-027a/b. The check runs per step, not per request: a saga that resumes hours
      // later must not act on authority its initiator no longer holds.
      const decision = await this.dependencies.authorization
        .authorizeAppAdministration(operation.initiatedBy, workspaceId);
      if (!decision.ok && decision.outcome === "denied") {
        return this.abandon(workspaceId, operation, installation, leaseOwner, new AppsError(
          "initiating_principal_unauthorized",
          "The operator who started this operation can no longer administer Apps in this workspace. A currently authorized operator must approve a new plan.",
        ));
      }
      if (!decision.ok) {
        // Indeterminate is not a revocation. The operation stays running at its cursor
        // with no new effect, the claim is handed back so a later retry can take it, and
        // that retry re-asks the same question (FR-027b).
        await this.dependencies.operations.release(operation.id, leaseOwner);
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
        const release = releaseBoundSteps.has(step.id) ? await this.releaseContextFor(installation) : null;
        const external = await this.runExternalEffect(step, workspaceId, installation, operation, plan, release);
        if (!external.ok) {
          this.logPortFailure(step, installation, operation, external.code);
          return this.abandon(
            workspaceId,
            operation,
            installation,
            leaseOwner,
            appPortFailureAsError(external.code, { step: step.id }),
          );
        }
        committed = await this.commitStep(step, workspaceId, installation, operation, plan, release, leaseOwner);
      } catch (error) {
        // A database/process failure after an external effect is deliberately allowed to
        // escape. The durable cursor and stable effect id make a later driver reconcile
        // it; turning an unknown crash into compensation would let one failing driver
        // tear down work another driver may just have committed.
        if (!(error instanceof AppsError)) throw error;
        return this.abandon(workspaceId, operation, installation, leaseOwner, error);
      }

      if (!committed) {
        // Another driver advanced this operation. Stopping here is what keeps two
        // concurrent retries from running the same step twice.
        return this.handedOver(installation, operation);
      }
      installation = committed.installation;
      operation = committed.operation;
      await this.dependencies.auditDelivery.drain();
    }

    const finished = await this.dependencies.unitOfWork.run(async (repositories) => {
      const done = await repositories.operations.finish(operation.id, {
        expectedState: "running",
        expectedStep: operation.step,
        leaseOwner,
        state: "completed",
        error: null,
      });
      if (!done) return null;
      await repositories.auditOutbox.enqueue([this.auditIntent(workspaceId, done, installation, {
        eventType: completionAuditEvent[done.kind],
        metadata: { state: installation.state, releaseId: installation.activeReleaseId },
      })]);
      return done;
    });
    if (!finished) return this.handedOver(installation, operation);
    await this.dependencies.auditDelivery.drain();
    return { installation, operation: finished };
  }

  /**
   * Everything a step does outside the database, named by the one effect id an
   * implementation deduplicates on. Running this after the claim and before the
   * transaction is deliberate: an external effect that lands and then loses its cursor is
   * replayed with the same `(operationId, stepId)` pair and must resolve to the same single
   * effect.
   */
  private runExternalEffect(
    step: AppSagaStep,
    workspaceId: string,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    plan: AppInstallationPlan | null,
    release: AppReleaseContext | null,
  ): Promise<AppPortResult> {
    const effect: AppLifecycleEffect = { operationId: operation.id, stepId: step.id };

    switch (step.id) {
      case "provision_runtime":
        return this.invoke(step, installation, operation, () => this.dependencies.runtimeProvisioning.provision({
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
        }));
      case "stage_contributions": {
        const request = this.stagingRequest(effect, workspaceId, installation, release!, operation, plan);
        return this.invoke(step, installation, operation, () => this.dependencies.contributionStaging.stage(request));
      }
      case "run_safe_tests": {
        const request = this.stagingRequest(effect, workspaceId, installation, release!, operation, plan);
        return this.invoke(step, installation, operation, () =>
          this.dependencies.contributionStaging.runSafeTests(request));
      }
      case "stop_runtime": {
        // A repair removal deprovisions the effect the unfinished rollback left behind, so
        // the provider recognises the runtime it is being asked to stop.
        const target = readRepairEffect(operation.payload) ?? effect;
        return this.invoke(step, installation, operation, () =>
          this.dependencies.runtimeProvisioning.deprovision({ effect: target, installationId: installation.id }));
      }
      case "detach_contributions":
        return this.invoke(step, installation, operation, () =>
          this.dependencies.contributionStaging.detach({ effect, installationId: installation.id }));
      case "dispose_data":
        return this.invoke(step, installation, operation, () => this.dependencies.dataDisposition.dispose({
          effect,
          workspaceId,
          installationId: installation.id,
          disposition: readDisposition(operation.payload.disposition),
        }));
      default:
        return Promise.resolve({ ok: true });
    }
  }

  /** An adapter that throws instead of answering contributes only the fact that it failed. */
  private async invoke(
    step: AppSagaStep,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    call: () => Promise<AppPortResult>,
  ): Promise<AppPortResult> {
    try {
      return await call();
    } catch {
      this.logAdapterThrow(step, installation, operation);
      return appPortFailure("adapter_error");
    }
  }

  /**
   * What is being staged or tested, resolved once from the manifest and the configuration
   * that will run it. A reconfigure stages its candidate, not the configuration the
   * installation is still using, so the port sees the proposal it is being asked to accept.
   */
  private stagingRequest(
    effect: AppLifecycleEffect,
    workspaceId: string,
    installation: AppInstallationRecord,
    release: AppReleaseContext,
    operation: AppLifecycleOperationRecord,
    plan: AppInstallationPlan | null,
  ): AppContributionStagingRequest {
    const configuration = operation.kind === "reconfigure"
      ? installation.candidateConfiguration ?? readConfiguration(operation.payload.configuration)
      : installation.configuration;
    const resolved = resolveInstallation(release.manifest, configuration);
    if (!resolved.ok) {
      const [issue] = resolved.issues;
      throw new AppsError("invalid_configuration", issue?.message ?? "Configuration is invalid.", {
        field: issue?.path ?? "configuration",
      });
    }
    const contributionIds = resolved.readiness.activeContributionIds.length > 0
      ? resolved.readiness.activeContributionIds
      : plan?.contributions.filter((contribution) => contribution.active).map((contribution) => contribution.id) ?? [];
    return {
      effect,
      installationId: installation.id,
      workspaceId,
      release: {
        id: release.record.id,
        appId: release.record.appId,
        version: release.record.version,
        manifestDigest: release.record.manifestDigest,
        artifactDigest: release.record.artifactDigest,
      },
      candidateRevision: candidateRevisionOf(operation),
      effectiveConfiguration: resolved.configuration,
      contributions: appContributionDescriptors(release.manifest, resolved.configuration, contributionIds),
    };
  }

  /**
   * Commits the step's database effects, its audit intent, and its cursor together. When
   * the compare-and-set matches nothing the whole transaction rolls back, so a driver that
   * lost the operation leaves no half-written effect behind.
   */
  private async commitStep(
    step: AppSagaStep,
    workspaceId: string,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    plan: AppInstallationPlan | null,
    release: AppReleaseContext | null,
    leaseOwner: string,
  ): Promise<StepCommit | null> {
    return this.dependencies.unitOfWork.run(async (repositories) => {
      const applied = await this.applyStepEffects(
        step,
        workspaceId,
        installation,
        operation,
        plan,
        release,
        repositories,
      );
      const advanced = await repositories.operations.advance(operation.id, {
        expectedState: "running",
        expectedStep: operation.step,
        leaseOwner,
        step: step.id,
      });
      if (!advanced) return null;
      await repositories.auditOutbox.enqueue(
        applied.audit.map((intent) => this.auditIntent(workspaceId, advanced, applied.installation, intent)),
      );
      return { installation: applied.installation, operation: advanced };
    });
  }

  private async applyStepEffects(
    step: AppSagaStep,
    workspaceId: string,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    plan: AppInstallationPlan | null,
    release: AppReleaseContext | null,
    repositories: AppsTransactionalRepositories,
  ): Promise<{ installation: AppInstallationRecord; audit: readonly AuditIntentDraft[] }> {
    const audit: AuditIntentDraft[] = [];
    let current = installation;

    switch (step.id) {
      case "persist_grants_and_connections": {
        if (plan) {
          // The approval is fenced on the release it was given for. Reading the release row
          // here takes a share lock on it, so a revocation racing this commit waits for it
          // instead of landing between the check and the write.
          await this.fenceRelease(repositories, plan.releaseId, plan.admissionPolicyVersion, plan.manifestDigest);
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
      case "open_candidate": {
        // The proposal becomes durable here, beside the configuration still in use, so a
        // resumed operation stages exactly what this one staged and a failure has something
        // to discard.
        current = await this.write(repositories, workspaceId, current, {
          candidateConfiguration: readConfiguration(operation.payload.configuration),
          candidateRevision: candidateRevisionOf(operation),
        });
        break;
      }
      case "apply_configuration": {
        const manifest = release?.manifest ?? (await this.releaseContextFor(current)).manifest;
        const resolved = resolveInstallation(
          manifest,
          current.candidateConfiguration ?? readConfiguration(operation.payload.configuration),
        );
        if (!resolved.ok) {
          const [issue] = resolved.issues;
          throw new AppsError("invalid_configuration", issue?.message ?? "Configuration is invalid.", {
            field: issue?.path ?? "configuration",
          });
        }
        current = await this.write(repositories, workspaceId, current, {
          configuration: resolved.configuration,
          candidateConfiguration: null,
          candidateRevision: null,
        });
        audit.push({
          eventType: "app.installation.configuration_changed",
          // Keys only: a configuration value can be a site URL or a customer identifier.
          metadata: { configurationKeys: Object.keys(resolved.configuration).sort() },
        });
        break;
      }
      case "activate": {
        const releaseId = current.candidateReleaseId ?? current.activeReleaseId;
        const context = release ?? (await this.releaseContextFor(current));
        if (!releaseId) throw notFound("App release not found");
        assertAppInstallationTransition(current.state, "active");
        const activated = await repositories.installations.activateRelease(
          workspaceId,
          current.id,
          current.version,
          {
            releaseId,
            admissionPolicyVersion: context.record.admissionPolicyVersion,
            manifestDigest: context.record.manifestDigest,
          },
        );
        if (!activated) {
          // The pointer did not move. Either the release stopped being the one that was
          // approved, or somebody else wrote the installation first.
          await this.fenceRelease(
            repositories,
            releaseId,
            context.record.admissionPolicyVersion,
            context.record.manifestDigest,
          );
          throw new AppsError("plan_stale", "The installation changed while this operation was running.", {
            cause: "version_mismatch",
          });
        }
        return { installation: activated, audit };
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

  /** Refuses unless the release is still exactly the one the authority was granted for. */
  private async fenceRelease(
    repositories: AppsTransactionalRepositories,
    releaseId: string,
    admissionPolicyVersion: string,
    manifestDigest: string,
  ): Promise<void> {
    const fenced = await repositories.releases.lockEligible({
      releaseId,
      admissionPolicyVersion,
      manifestDigest,
      allowedStates: ["admitted"],
    });
    if (fenced) return;
    throw new AppsError(
      "release_not_eligible",
      "This release is no longer admitted, so it cannot be installed or activated.",
      { releaseId },
    );
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
      candidateConfiguration?: Readonly<Record<string, unknown>> | null;
      candidateRevision?: string | null;
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
  private async releaseContextFor(installation: AppInstallationRecord): Promise<AppReleaseContext> {
    const releaseId = installation.candidateReleaseId ?? installation.activeReleaseId;
    const record = releaseId ? await this.dependencies.releases.findById(releaseId) : null;
    if (!record) throw notFound("App release not found");
    return { record, manifest: assertAppReleaseEligible(record, this.dependencies.runningRadiosoVersion) };
  }

  /**
   * Compensates what committed, in reverse, then records the failure. Compensation is
   * system-owned safety work and runs even when the initiating principal has lost access.
   *
   * Opening it is a compare-and-set on the exact state, step, and lease this driver holds.
   * A driver that lost the step does not get to roll back the work the winner completed.
   */
  private async abandon(
    workspaceId: string,
    operation: AppLifecycleOperationRecord,
    installation: AppInstallationRecord,
    leaseOwner: string,
    error: unknown,
  ): Promise<AppLifecycleOutcome> {
    const failure = failureOf(error);
    const compensating = await this.dependencies.operations.finish(operation.id, {
      expectedState: "running",
      expectedStep: operation.step,
      leaseOwner,
      state: "compensating",
      error: failure,
    });
    if (!compensating) return this.handedOver(installation, operation);
    return this.compensate(workspaceId, compensating, installation, leaseOwner, failure);
  }

  private async compensate(
    workspaceId: string,
    startingOperation: AppLifecycleOperationRecord,
    startingInstallation: AppInstallationRecord,
    leaseOwner: string,
    failure: { readonly reason: string; readonly message: string },
  ): Promise<AppLifecycleOutcome> {
    let operation = startingOperation;
    const installation = startingInstallation;
    let cursor = operation.compensationStep;

    for (const step of remainingAppSagaCompensationSteps(operation.kind, operation.step, cursor)) {
      const claimed = await this.dependencies.operations.claim(operation.id, {
        expectedState: "compensating",
        expectedStep: operation.step,
        expectedCompensationStep: cursor,
        leaseOwner,
        leaseExpiresAt: this.leaseExpiry(),
        now: this.now(),
      });
      if (!claimed) return this.handedOver(installation, operation);
      operation = claimed;

      const result = await this.compensateStep(step, installation, operation, cursor, leaseOwner);
      if (!result.ok) {
        this.logPortFailure(step, installation, operation, result.code);
        return this.stopUnfinished(workspaceId, operation, installation, leaseOwner, cursor, failure);
      }
      if (result.operation === null) return this.handedOver(installation, operation);
      operation = result.operation;
      cursor = step.id;
    }

    // A resumed rollback can already have completed its final compensator.  It still
    // needs an exact lease before its terminal state is written; otherwise that last
    // cursor leaves the operation stuck in `compensating` indefinitely.
    const finalClaim = await this.dependencies.operations.claim(operation.id, {
      expectedState: "compensating",
      expectedStep: operation.step,
      expectedCompensationStep: cursor,
      leaseOwner,
      leaseExpiresAt: this.leaseExpiry(),
      now: this.now(),
    });
    if (!finalClaim) return this.handedOver(installation, operation);
    operation = finalClaim;
    return this.finishCompensated(workspaceId, operation, installation, leaseOwner, failure);
  }

  /**
   * Rollback could not finish. The operation's terminal state, the compensation cursor an
   * operator reads it by, and the installation's health commit together — a crash between
   * them would leave an operation that says it stopped and an installation that says it is
   * fine.
   */
  private async stopUnfinished(
    workspaceId: string,
    operation: AppLifecycleOperationRecord,
    installation: AppInstallationRecord,
    leaseOwner: string,
    cursor: AppLifecycleOperationRecord["compensationStep"],
    failure: { readonly reason: string; readonly message: string },
  ): Promise<AppLifecycleOutcome> {
    const committed = await this.dependencies.unitOfWork.run(async (repositories) => {
      const stopped = await repositories.operations.finish(operation.id, {
        expectedState: "compensating",
        expectedStep: operation.step,
        expectedCompensationStep: cursor,
        leaseOwner,
        state: "compensation_failed",
        compensationStep: cursor,
        error: {
          reason: failure.reason,
          message: `${failure.message} Rolling this operation back did not finish; an operator needs to review this installation.`,
        },
      });
      if (!stopped) return null;
      const failed = await this.markFailed(repositories, workspaceId, operation.kind, installation, failure);
      await repositories.auditOutbox.enqueue([this.auditIntent(workspaceId, stopped, failed, {
        eventType: "app.installation.failed",
        metadata: { step: stopped.step, compensationStep: cursor, reason: failure.reason, compensated: false },
      })]);
      return { installation: failed, operation: stopped };
    });
    if (!committed) return this.handedOver(installation, operation);
    await this.dependencies.auditDelivery.drain();
    return committed;
  }

  private async finishCompensated(
    workspaceId: string,
    operation: AppLifecycleOperationRecord,
    installation: AppInstallationRecord,
    leaseOwner: string,
    failure: { readonly reason: string; readonly message: string },
  ): Promise<AppLifecycleOutcome> {
    const committed = await this.dependencies.unitOfWork.run(async (repositories) => {
      const finished = await repositories.operations.finish(operation.id, {
        expectedState: "compensating",
        expectedStep: operation.step,
        leaseOwner,
        state: "failed",
        error: failure,
      });
      if (!finished) return null;
      // A reconfigure is a candidate beside a working installation. Once its candidate
      // compensator has discarded that proposal, the prior active/disabled/planned state
      // and effective configuration remain authoritative; only the operation records the
      // failed attempt. Treating a failed candidate as a failed runtime would take a
      // healthy App out of service for a change that never applied.
      const outcomeInstallation = operation.kind === "reconfigure"
        ? installation
        : await this.markFailed(repositories, workspaceId, operation.kind, installation, failure);
      await repositories.auditOutbox.enqueue([this.auditIntent(workspaceId, finished, outcomeInstallation, {
        eventType: operation.kind === "reconfigure" ? "app.installation.reconfigure_failed" : "app.installation.failed",
        metadata: { step: finished.step, reason: failure.reason, compensated: true },
      })]);
      return { installation: outcomeInstallation, operation: finished };
    });
    if (!committed) return this.handedOver(installation, operation);
    this.dependencies.logger.warn(
      {
        installationId: installation.id,
        operationId: committed.operation.id,
        operationKind: committed.operation.kind,
        reason: failure.reason,
      },
      "App lifecycle operation failed",
    );
    await this.dependencies.auditDelivery.drain();
    return committed;
  }

  private async compensateStep(
    step: AppSagaStep,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    cursor: AppLifecycleOperationRecord["compensationStep"],
    leaseOwner: string,
  ): Promise<
    | { ok: true; operation: AppLifecycleOperationRecord | null }
    | { ok: false; code: AppPortFailureCode }
  > {
    const effect: AppLifecycleEffect = { operationId: operation.id, stepId: `compensate:${step.id}` };
    const ownership = {
      expectedState: "compensating" as const,
      expectedStep: operation.step,
      expectedCompensationStep: cursor,
      leaseOwner,
    };
    const advance = async (): Promise<AppLifecycleOperationRecord | null> =>
      this.dependencies.operations.advanceCompensation(operation.id, { ...ownership, compensationStep: step.id });

    switch (step.id) {
      case "persist_grants_and_connections": {
        const advanced = await this.dependencies.unitOfWork.run(async (repositories) => {
          await repositories.grants.revokeAll(installation.id, this.now());
          return repositories.operations.advanceCompensation(operation.id, {
            ...ownership,
            compensationStep: step.id,
          });
        });
        return { ok: true, operation: advanced };
      }
      case "open_candidate": {
        // The proposal is dropped, so the installation goes back to answering with the
        // configuration it was already running.
        const discarded = await this.invoke(step, installation, operation, () =>
          this.dependencies.contributionStaging.discardCandidate({
            effect,
            installationId: installation.id,
            candidateRevision: candidateRevisionOf(operation),
          }));
        if (!discarded.ok) return discarded;
        const advanced = await this.dependencies.unitOfWork.run(async (repositories) => {
          await repositories.installations.update(
            operation.workspaceId,
            installation.id,
            installation.version,
            { candidateConfiguration: null, candidateRevision: null },
          );
          return repositories.operations.advanceCompensation(operation.id, {
            ...ownership,
            compensationStep: step.id,
          });
        });
        return { ok: true, operation: advanced };
      }
      case "provision_runtime": {
        const result = await this.invoke(step, installation, operation, () =>
          this.dependencies.runtimeProvisioning.deprovision({ effect, installationId: installation.id }));
        if (!result.ok) return result;
        return { ok: true, operation: await advance() };
      }
      case "stage_contributions": {
        const result = await this.invoke(step, installation, operation, () =>
          this.dependencies.contributionStaging.detach({ effect, installationId: installation.id }));
        if (!result.ok) return result;
        return { ok: true, operation: await advance() };
      }
      default:
        return { ok: true, operation: await advance() };
    }
  }

  private async markFailed(
    repositories: AppsTransactionalRepositories,
    workspaceId: string,
    kind: AppLifecycleOperationKind,
    installation: AppInstallationRecord,
    failure: { readonly reason: string; readonly message: string },
  ): Promise<AppInstallationRecord> {
    if (kindsThatPreserveTheInstallation.has(kind)) return installation;
    if (installation.state === "removed" || installation.state === "failed") return installation;
    const failed = await repositories.installations.update(
      workspaceId,
      installation.id,
      installation.version,
      { state: "failed", health: { reason: failure.reason, message: failure.message } },
    );
    return failed ?? installation;
  }

  private auditIntent(
    workspaceId: string,
    operation: AppLifecycleOperationRecord,
    installation: AppInstallationRecord,
    draft: AuditIntentDraft,
  ): AppAuditIntent {
    return {
      workspaceId,
      accountId: operation.initiatedBy.accountId,
      eventType: draft.eventType,
      eventStatus: draft.eventType.endsWith(".failed") ? "failure" : "success",
      metadata: {
        installationId: installation.id,
        appId: installation.appId,
        operationId: operation.id,
        operationKind: operation.kind,
        // FR-064: which administrator this was, not merely which account.
        actorUserId: operation.initiatedBy.userId,
        ...draft.metadata,
      },
    };
  }

  private logPortFailure(
    step: AppSagaStep,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    code: string,
  ): void {
    this.dependencies.logger.warn(
      {
        installationId: installation.id,
        operationId: operation.id,
        operationKind: operation.kind,
        step: step.id,
        code,
      },
      "App lifecycle step refused by a platform port",
    );
  }

  /**
   * Identity included. An adapter's `message`, `name`, and `code` are all adapter-controlled
   * and can carry a token or a connection string, so none of them is read: what is logged
   * is the operation, the step, and the effect this platform owns.
   */
  private logAdapterThrow(
    step: AppSagaStep,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
  ): void {
    this.dependencies.logger.error(
      {
        installationId: installation.id,
        operationId: operation.id,
        operationKind: operation.kind,
        step: step.id,
        effectId: `${operation.id}:${step.id}`,
      },
      "App lifecycle adapter threw instead of reporting a typed result",
    );
  }
}

interface AuditIntentDraft {
  readonly eventType: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * The one place a failure becomes text. An `AppsError` carries a message written in this
 * repository; anything else contributes only the fact that it failed.
 */
const failureOf = (error: unknown): { reason: string; message: string } =>
  error instanceof AppsError
    ? { reason: error.reason, message: error.message }
    : { reason: "internal", message: "This App lifecycle operation could not be completed." };

/**
 * The operation is the candidate's identity. It is stable across drivers and resumes, so a
 * staging implementation sees one revision per proposal however many times it is asked.
 */
const candidateRevisionOf = (operation: AppLifecycleOperationRecord): string => operation.id;

const readRepairEffect = (payload: Readonly<Record<string, unknown>>): AppLifecycleEffect | null => {
  const repair = payload.repair;
  if (!repair || typeof repair !== "object") return null;
  const candidate = repair as { operationId?: unknown; stepId?: unknown };
  if (typeof candidate.operationId !== "string" || typeof candidate.stepId !== "string") return null;
  return { operationId: candidate.operationId, stepId: candidate.stepId };
};

const readDisposition = (value: unknown): AppDataDisposition =>
  value === "export" || value === "delete" ? value : "retain";

const readConfiguration = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
