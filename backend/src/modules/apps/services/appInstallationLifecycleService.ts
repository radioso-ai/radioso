import { randomUUID } from "node:crypto";

import { resolveInstallation, type AdmittedManifest } from "@radioso/app-contract";

import { notFound } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { requireAppAdministration } from "../domain/authorization.js";
import { appContributionDescriptors } from "../domain/contributionDescriptor.js";
import { AppsError } from "../domain/errors.js";
import {
  appInstallationStates,
  assertAppCommandSourceState,
  assertAppInstallationTransition,
  canTransitionAppInstallation,
  remainingAppSagaCompensationSteps,
  remainingAppSagaSteps,
  type AppInstallationState,
  type AppLifecycleOperationKind,
  type AppSagaStep,
  type AppSagaStepId,
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
  parseAppPortResult,
  type AppPortFailureCode,
  type AppPortResult,
} from "../domain/portOutcome.js";
import {
  assertExistingInstallationReleaseUsable,
  assertNewInstallReleaseEligible,
  existingInstallationReleaseStates,
  newInstallReleaseStates,
} from "../domain/releaseAdmission.js";
import type {
  AppInstallationRecord,
  AppLifecycleOperationRecord,
  AppReleaseRecord,
  AppReleaseState,
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
import {
  APP_STEP_HEARTBEAT_MS,
  APP_STEP_LEASE_MS,
  callUnderAppStepLease,
  createAppLeaseTimer,
  type AppLeaseTimer,
} from "./appStepLease.js";

/** How many stalled operations one recovery pass re-drives. */
const RECOVERY_BATCH_SIZE = 20;

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
  /** Injectable so a test can drive a heartbeat without waiting out a real lease. */
  readonly leaseTimer?: AppLeaseTimer;
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

/**
 * Operations every committed effect of which a clean rollback undoes, so the installation
 * can be returned to the state the command was issued against. Removal and data
 * disposition are deliberately absent: revoked grants, deleted credentials, and disposed
 * data are not restored by a compensator, so there is nothing to return them to.
 */
const kindsThatRestoreTheirSourceState = new Set<AppLifecycleOperationKind>([
  "install",
  "activate",
  "enable",
  "disable",
]);

/** Thrown inside a claim transaction when the request turns out to be a retry of one already open. */
class ReplayExistingOperation extends Error {
  constructor(readonly operationId: string) {
    super("replay");
  }
}

/**
 * Thrown inside a unit of work when this driver turns out not to own the operation any
 * more. It exists so the loss rolls the transaction back: a lost compare-and-set that
 * merely returned `null` would let the effects written before it commit, leaving grants,
 * installation state, or a discarded candidate visible with no cursor and no audit record
 * saying they happened. Outside the transaction it becomes the ordinary "another driver
 * owns this" answer.
 */
class AppOperationHandover extends Error {
  constructor() {
    super("handover");
  }
}

interface StepCommit {
  readonly installation: AppInstallationRecord;
  readonly operation: AppLifecycleOperationRecord;
}

/** A driver's claim on one step, and the one thing it can do with it while a call runs. */
interface AppStepHold {
  renew(): Promise<boolean>;
}

/** A port answer this driver is still entitled to act on, or the fact that it is not. */
type AppStepCall =
  | { readonly held: true; readonly result: AppPortResult }
  | { readonly held: false };

/**
 * What one compensator produced. `held: false` is not a failed rollback — it is a driver
 * that stopped owning the operation while the compensator ran, which must not be recorded
 * as a rollback that could not finish.
 */
type CompensationStepOutcome =
  | {
    readonly ok: true;
    readonly operation: AppLifecycleOperationRecord | null;
    readonly installation: AppInstallationRecord;
  }
  | { readonly ok: false; readonly held: true; readonly code: AppPortFailureCode }
  | { readonly ok: false; readonly held: false };

interface AppReleaseContext {
  readonly record: AppReleaseRecord;
  readonly manifest: AdmittedManifest;
  /** The release states this operation's kind may act through. */
  readonly allowedStates: readonly AppReleaseState[];
}

/**
 * Which release rule an operation answers to.
 *
 * Founding an installation and keeping one working are different questions. `install` and
 * the first `activate` create something new, so they need a release that is still offered;
 * a reconfigure, a re-enable, and a removal act on an installation an operator already has,
 * and deprecation must not take that away from them.
 */
const releaseUsageForKind = (kind: AppLifecycleOperationKind): "new_install" | "existing_installation" =>
  kind === "install" || kind === "activate" ? "new_install" : "existing_installation";

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
  private timer: AppLeaseTimer | undefined;

  constructor(private readonly dependencies: AppInstallationLifecycleDependencies) {
    this.timer = dependencies.leaseTimer;
  }

  private now(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }

  private leaseExpiry(): Date {
    return new Date(this.now().getTime() + APP_STEP_LEASE_MS);
  }

  private get leaseTimer(): AppLeaseTimer {
    this.timer ??= createAppLeaseTimer();
    return this.timer;
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

    const resumed = await this.resumeIfAlreadyClaimed(request.workspaceId, request.idempotencyKey, fingerprint);
    if (resumed) return resumed;

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
    assertNewInstallReleaseEligible(release, this.dependencies.runningRadiosoVersion);

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

      // Locking the release row before the conditional update is what makes the two agree.
      // The update's own predicates read a snapshot; a revocation committing between that
      // read and this write would leave a plan consumed against authority that had already
      // been withdrawn.
      await this.fenceRelease(
        repositories,
        plan.releaseId,
        plan.admissionPolicyVersion,
        plan.manifestDigest,
        newInstallReleaseStates,
      );

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
        // Two retries of the same request can both pass the lookup above and race here.
        // The loser blocks on the winner's row lock and only then sees the plan consumed,
        // so the winner's operation is visible: it is the same attempt, and answering
        // "this plan is stale" for a request that succeeded would be a lie.
        const raced = await repositories.operations
          .findByIdempotencyKey(request.workspaceId, request.idempotencyKey);
        if (raced) throw this.replayOrRefuse(raced, fingerprint);
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
        payload: {
          planId: planRecord.id,
          checksum: planRecord.checksum,
          releaseId: plan.releaseId,
          sourceState: installation.state,
        },
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
   * Re-drives the operations nobody is driving.
   *
   * An operation only moves while a driver holds it, and a driver is a request or a
   * process that can die. What it leaves behind is a running or compensating operation
   * with a lapsed claim, and until something picks it up the installation's in-flight
   * fence refuses every command — including the removal that would clear it. This is
   * Apps-owned rather than a caller's loop because what counts as stalled, and what
   * resuming means in each direction, is this module's rule.
   */
  async recoverStalledOperations(limit: number = RECOVERY_BATCH_SIZE): Promise<number> {
    const stalled = await this.dependencies.operations.listStalled({ now: this.now(), limit });
    let resumed = 0;
    for (const operation of stalled) {
      try {
        await this.resumeById(operation.workspaceId, operation.id);
        resumed += 1;
      } catch (error) {
        // One operation that cannot be resumed must not stop the rest. An `AppsError`
        // carries a reason written in this repository; anything else contributes only
        // that it failed.
        this.dependencies.logger.warn(
          {
            operationId: operation.id,
            operationKind: operation.kind,
            installationId: operation.installationId,
            reason: error instanceof AppsError ? error.reason : "internal",
          },
          "Stalled App lifecycle operation could not be resumed",
        );
      }
    }
    if (resumed > 0) {
      this.dependencies.logger.info({ resumed }, "Resumed stalled App lifecycle operations");
    }
    return resumed;
  }

  /**
   * The answer to "have I already been asked this", asked before anything mutable is read.
   * A matching fingerprint is the same attempt and is resumed or reported; a different one
   * is a reused key and is refused.
   */
  private async resumeIfAlreadyClaimed(
    workspaceId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<AppLifecycleOutcome | null> {
    const existing = await this.dependencies.operations.findByIdempotencyKey(workspaceId, idempotencyKey);
    if (!existing) return null;
    const replay = this.replayOrRefuse(existing, fingerprint);
    if (!(replay instanceof ReplayExistingOperation)) throw replay;
    return this.resumeById(workspaceId, replay.operationId);
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

    // The scoped key is asked before anything mutable is read. An operation that crashed
    // mid-flight has to stay reachable by the key that started it, even after the release
    // it was using was revoked — otherwise the one retry that could resume and compensate
    // it is refused by a preflight, and the in-flight fence stays occupied for good.
    const resumed = await this.resumeIfAlreadyClaimed(request.workspaceId, request.idempotencyKey, fingerprint);
    if (resumed) return resumed;

    // A rollback that could not finish is repaired by finishing it, not by starting a new
    // operation that guesses which compensator was owed. The repair writes to the
    // installation, so the version the operator read is stale afterwards through no fault
    // of theirs — and no other writer can have touched it, because the unfinished rollback
    // held the in-flight fence the whole time. So the repair's own version carries forward.
    const repaired = await this.repairUnfinishedRollback(request.workspaceId, request.installationId, kind);
    const expectedVersion = repaired?.version ?? request.expectedVersion;

    if (kind === "activate") await this.assertRequiredConnectionsBound(request.workspaceId, request.installationId);

    const now = this.now();
    const claimed = await this.claiming(async (repositories) => {
      const replayed = await repositories.operations
        .findByIdempotencyKey(request.workspaceId, request.idempotencyKey);
      if (replayed) throw this.replayOrRefuse(replayed, fingerprint);

      const current = await repositories.installations.findById(request.workspaceId, request.installationId);
      if (!current) throw notFound("App installation not found");

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
        // The state this command was issued against. A clean rollback puts the
        // installation back into it, so an attempt that failed is an attempt, not damage.
        payload: { ...payload, sourceState: current.state },
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
        expectedVersion,
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
   * Finishes a rollback that stopped, using the operation that stopped it.
   *
   * A compensation cursor names the compensator that was owed, and every compensator's
   * effect id is `(that operation, compensate:<step>)`. Starting a fresh operation to
   * repair the damage would call the provider with an id it has never seen, so an external
   * effect that was already reversed can be reversed twice and one that was not can be
   * missed entirely. So the failed operation is reopened where it stopped and driven to
   * the end; only when it finishes is the installation free for the removal to proceed.
   */
  private async repairUnfinishedRollback(
    workspaceId: string,
    installationId: string,
    kind: AppLifecycleOperationKind,
  ): Promise<AppInstallationRecord | null> {
    const holding = await this.dependencies.operations.findActiveByInstallation(installationId);
    if (holding?.state !== "compensation_failed") return null;
    if (kind !== "remove") {
      throw new AppsError(
        "operation_in_progress",
        "This installation's rollback did not finish, so only removal can repair it.",
        { operationId: holding.id },
      );
    }

    const installation = await this.loadInstallation(workspaceId, installationId);
    const failure = holding.error ?? { reason: "internal", message: "This operation was abandoned." };
    const reopened = await this.dependencies.operations.finish(holding.id, {
      expectedState: "compensation_failed",
      expectedStep: holding.step,
      expectedCompensationStep: holding.compensationStep,
      // A stopped operation owns no driver, so the empty token requires the NULL lease
      // rather than bypassing the state and cursor compare-and-set.
      leaseOwner: "",
      state: "compensating",
      error: holding.error,
    });
    if (!reopened) {
      throw new AppsError(
        "operation_in_progress",
        "This installation's unfinished rollback changed while it was being repaired. Retry.",
        { operationId: holding.id },
      );
    }

    const outcome = await this.compensate(workspaceId, reopened, installation, randomUUID(), failure);
    if (outcome.operation.state === "failed") return outcome.installation;
    throw new AppsError(
      "operation_in_progress",
      "This installation's rollback still could not finish, so the removal did not start. Retry it.",
      { operationId: holding.id },
    );
  }

  /**
   * Never counts a slot as bound without a connection record (FR-031). A host-minted slot
   * is satisfied by the bind that mints it, not by the fact that the host could.
   */
  private async assertRequiredConnectionsBound(workspaceId: string, installationId: string): Promise<void> {
    const installation = await this.loadInstallation(workspaceId, installationId);
    const { manifest } = await this.releaseContextFor(installation, "new_install");
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

      const hold = this.holdOn(operation, leaseOwner, {
        expectedState: "running",
        expectedStep: operation.step,
      });

      let committed: StepCommit | null;
      try {
        const release = releaseBoundSteps.has(step.id)
          ? await this.releaseContextFor(installation, releaseUsageForKind(operation.kind))
          : null;
        const external = await this.runExternalEffect(step, workspaceId, installation, operation, plan, release, hold);
        // The claim lapsed, or could not be renewed, while the port call was in flight.
        // The result is discarded and nothing is written: another driver may already be
        // acting on this step, and the effect id is stable, so whoever owns it reconciles
        // the same single external effect.
        if (!external.held) return this.handedOver(installation, operation);
        if (!external.result.ok) {
          this.logPortFailure(step, installation, operation, external.result.code);
          return this.abandon(
            workspaceId,
            operation,
            installation,
            leaseOwner,
            appPortFailureAsError(external.result.code, { step: step.id }),
          );
        }
        committed = await this.commitStep(step, workspaceId, installation, operation, plan, release, leaseOwner);
      } catch (error) {
        // Another driver advanced this operation and the commit rolled back. Stopping here
        // is what keeps two concurrent retries from running the same step twice.
        if (error instanceof AppOperationHandover) return this.handedOver(installation, operation);
        // A database/process failure after an external effect is deliberately allowed to
        // escape. The durable cursor and stable effect id make a later driver reconcile
        // it; turning an unknown crash into compensation would let one failing driver
        // tear down work another driver may just have committed.
        if (!(error instanceof AppsError)) throw error;
        return this.abandon(workspaceId, operation, installation, leaseOwner, error);
      }

      if (!committed) return this.handedOver(installation, operation);
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
    hold: AppStepHold,
  ): Promise<AppStepCall> {
    const effect: AppLifecycleEffect = { operationId: operation.id, stepId: step.id };

    switch (step.id) {
      case "provision_runtime":
        return this.invoke(step, installation, operation, hold, () => this.dependencies.runtimeProvisioning.provision({
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
        return this.invoke(step, installation, operation, hold, () =>
          this.dependencies.contributionStaging.stage(request));
      }
      case "run_safe_tests": {
        const request = this.stagingRequest(effect, workspaceId, installation, release!, operation, plan);
        return this.invoke(step, installation, operation, hold, () =>
          this.dependencies.contributionStaging.runSafeTests(request));
      }
      case "apply_configuration":
        // Adoption is the port's decision to make the staged mapping the one that answers.
        // The transaction that follows moves `activeRevision` to the same revision, so the
        // projection and the installation never disagree about which one is live.
        return this.invoke(step, installation, operation, hold, () =>
          this.dependencies.contributionStaging.promote({
            effect,
            installationId: installation.id,
            candidateRevision: candidateRevisionOf(operation),
          }));
      case "stop_runtime":
        return this.invoke(step, installation, operation, hold, () =>
          this.dependencies.runtimeProvisioning.deprovision({ effect, installationId: installation.id }));
      case "detach_contributions":
        return this.invoke(step, installation, operation, hold, () =>
          this.dependencies.contributionStaging.detach({ effect, installationId: installation.id }));
      case "dispose_data":
        return this.invoke(step, installation, operation, hold, () => this.dependencies.dataDisposition.dispose({
          effect,
          workspaceId,
          installationId: installation.id,
          disposition: readDisposition(operation.payload.disposition),
        }));
      default:
        return Promise.resolve({ held: true, result: { ok: true } });
    }
  }

  /**
   * What this driver believes it holds, and how it says so again. Renewal is a claim on
   * the exact same state and cursor, so it succeeds only while nobody else has taken over.
   */
  private holdOn(
    operation: AppLifecycleOperationRecord,
    leaseOwner: string,
    ownership: {
      readonly expectedState: AppLifecycleOperationRecord["state"];
      readonly expectedStep: AppSagaStepId | null;
      readonly expectedCompensationStep?: AppSagaStepId | null;
    },
  ): AppStepHold {
    return {
      renew: async () => (await this.dependencies.operations.claim(operation.id, {
        ...ownership,
        leaseOwner,
        leaseExpiresAt: this.leaseExpiry(),
        now: this.now(),
      })) !== null,
    };
  }

  /**
   * One port call, kept inside the claim it was made under.
   *
   * Three things can come back: a result this driver may act on, a refusal, or the fact
   * that the claim is gone. An adapter that throws contributes only that it failed, and an
   * adapter that answers with something that is not a port result contributes only that it
   * broke the protocol — neither value is read for text or for a code.
   */
  private async invoke(
    step: AppSagaStep,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    hold: AppStepHold,
    call: () => Promise<AppPortResult>,
  ): Promise<AppStepCall> {
    try {
      const outcome = await callUnderAppStepLease({
        renew: hold.renew,
        call,
        heartbeatMs: APP_STEP_HEARTBEAT_MS,
        // The deadline is the lease: a call this driver can no longer keep its claim alive
        // through is one whose result it may not act on.
        deadlineMs: APP_STEP_LEASE_MS,
        timer: this.leaseTimer,
      });
      if (!outcome.held) {
        this.dependencies.logger.warn(
          {
            installationId: installation.id,
            operationId: operation.id,
            operationKind: operation.kind,
            step: step.id,
            reason: outcome.reason,
          },
          "App lifecycle step result discarded: this driver no longer holds the operation",
        );
        return { held: false };
      }
      return { held: true, result: parseAppPortResult(outcome.value) };
    } catch {
      this.logAdapterThrow(step, installation, operation);
      return { held: true, result: appPortFailure("adapter_error") };
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
   * the compare-and-set matches nothing this throws inside the transaction, so the whole
   * unit rolls back and a driver that lost the operation leaves no half-written effect
   * behind. The caller translates the throw into the ordinary handover answer.
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
      // The effects above are already written in this transaction. Returning here would
      // commit them without the cursor that says they happened, so the loss is thrown and
      // the whole unit rolls back.
      if (!advanced) throw new AppOperationHandover();
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
          await this.fenceRelease(
            repositories,
            plan.releaseId,
            plan.admissionPolicyVersion,
            plan.manifestDigest,
            newInstallReleaseStates,
          );
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
        const manifest = release?.manifest
          ?? (await this.releaseContextFor(current, releaseUsageForKind(operation.kind))).manifest;
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
        // The candidate the staging port just promoted becomes the live revision in the
        // same commit that makes its configuration the live configuration. Split across
        // two writes, an interruption would leave a projection serving one revision and an
        // installation naming another.
        current = await this.write(repositories, workspaceId, current, {
          configuration: resolved.configuration,
          activeRevision: candidateRevisionOf(operation),
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
        const context = release
          ?? (await this.releaseContextFor(current, releaseUsageForKind(operation.kind)));
        if (!releaseId) throw notFound("App release not found");
        assertAppInstallationTransition(current.state, "active");
        // Locking the release before the pointer moves is what makes a revocation racing
        // this commit wait for it. The conditional update repeats the predicates, but its
        // own read is a snapshot: without the lock a revocation can commit first and
        // become visible only after an active pointer has already been written to it.
        await this.fenceRelease(
          repositories,
          releaseId,
          context.record.admissionPolicyVersion,
          context.record.manifestDigest,
          context.allowedStates,
        );
        const activated = await repositories.installations.activateRelease(
          workspaceId,
          current.id,
          current.version,
          {
            releaseId,
            admissionPolicyVersion: context.record.admissionPolicyVersion,
            manifestDigest: context.record.manifestDigest,
            activeRevision: candidateRevisionOf(operation),
            allowedReleaseStates: context.allowedStates,
          },
        );
        if (!activated) {
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

  /**
   * Refuses unless the release is still exactly the one the authority was granted for, and
   * takes a share lock on it for the rest of the transaction so it stays that way until
   * the commit.
   */
  private async fenceRelease(
    repositories: AppsTransactionalRepositories,
    releaseId: string,
    admissionPolicyVersion: string,
    manifestDigest: string,
    allowedStates: readonly AppReleaseState[],
  ): Promise<void> {
    const fenced = await repositories.releases.lockEligible({
      releaseId,
      admissionPolicyVersion,
      manifestDigest,
      allowedStates,
    });
    if (fenced) return;
    throw new AppsError(
      "release_not_eligible",
      "This release is no longer usable, so this operation cannot act on it.",
      { releaseId },
    );
  }

  /** Validation for a reconfigure, run as its own step so a resume re-establishes it. */
  private async validateReconfiguration(
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
  ): Promise<void> {
    const { manifest } = await this.releaseContextFor(installation, "existing_installation");
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
      activeRevision?: string | null;
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

  /** The release this installation is acting on, re-established as currently usable. */
  private async releaseContextFor(
    installation: AppInstallationRecord,
    usage: "new_install" | "existing_installation",
  ): Promise<AppReleaseContext> {
    const releaseId = installation.candidateReleaseId ?? installation.activeReleaseId;
    const record = releaseId ? await this.dependencies.releases.findById(releaseId) : null;
    if (!record) throw notFound("App release not found");
    return usage === "new_install"
      ? {
        record,
        manifest: assertNewInstallReleaseEligible(record, this.dependencies.runningRadiosoVersion),
        allowedStates: newInstallReleaseStates,
      }
      : {
        record,
        manifest: assertExistingInstallationReleaseUsable(record, this.dependencies.runningRadiosoVersion),
        allowedStates: existingInstallationReleaseStates,
      };
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
    let installation = startingInstallation;
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

      let result: CompensationStepOutcome;
      try {
        result = await this.compensateStep(step, installation, operation, cursor, leaseOwner);
      } catch (error) {
        if (error instanceof AppOperationHandover) return this.handedOver(installation, operation);
        throw error;
      }
      if (!result.ok) {
        if (!result.held) return this.handedOver(installation, operation);
        this.logPortFailure(step, installation, operation, result.code);
        return this.stopUnfinished(workspaceId, operation, installation, leaseOwner, cursor, failure);
      }
      if (result.operation === null) return this.handedOver(installation, operation);
      operation = result.operation;
      // The compensator's own write is the authority on what the installation now is; the
      // record this runner carried in is one revision behind it from here on.
      installation = result.installation;
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
      const outcomeInstallation = await this.restoreSourceState(
        repositories,
        workspaceId,
        operation,
        installation,
        failure,
      );
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
  ): Promise<CompensationStepOutcome> {
    const effect: AppLifecycleEffect = { operationId: operation.id, stepId: `compensate:${step.id}` };
    const ownership = {
      expectedState: "compensating" as const,
      expectedStep: operation.step,
      expectedCompensationStep: cursor,
      leaseOwner,
    };
    const hold = this.holdOn(operation, leaseOwner, {
      expectedState: "compensating",
      expectedStep: operation.step,
      expectedCompensationStep: cursor,
    });
    const advance = async (): Promise<AppLifecycleOperationRecord | null> =>
      this.dependencies.operations.advanceCompensation(operation.id, { ...ownership, compensationStep: step.id });

    switch (step.id) {
      case "persist_grants_and_connections": {
        const advanced = await this.dependencies.unitOfWork.run(async (repositories) => {
          await repositories.grants.revokeAll(installation.id, this.now());
          const moved = await repositories.operations.advanceCompensation(operation.id, {
            ...ownership,
            compensationStep: step.id,
          });
          if (!moved) throw new AppOperationHandover();
          return moved;
        });
        return { ok: true, operation: advanced, installation };
      }
      case "open_candidate": {
        // The proposal is dropped, so the installation goes back to answering with the
        // configuration it was already running.
        const discarded = await this.invoke(step, installation, operation, hold, () =>
          this.dependencies.contributionStaging.discardCandidate({
            effect,
            installationId: installation.id,
            candidateRevision: candidateRevisionOf(operation),
          }));
        if (!discarded.held) return { ok: false, held: false };
        if (!discarded.result.ok) return { ok: false, held: true, code: discarded.result.code };
        const committed = await this.dependencies.unitOfWork.run(async (repositories) => {
          const cleared = await repositories.installations.update(
            operation.workspaceId,
            installation.id,
            installation.version,
            { candidateConfiguration: null, candidateRevision: null },
          );
          // The candidate is gone from the staging projection; failing to clear it here
          // would leave the installation naming a revision that no longer exists.
          if (!cleared) throw new AppOperationHandover();
          const moved = await repositories.operations.advanceCompensation(operation.id, {
            ...ownership,
            compensationStep: step.id,
          });
          if (!moved) throw new AppOperationHandover();
          return { operation: moved, installation: cleared };
        });
        return { ok: true, operation: committed.operation, installation: committed.installation };
      }
      case "provision_runtime": {
        const result = await this.invoke(step, installation, operation, hold, () =>
          this.dependencies.runtimeProvisioning.deprovision({ effect, installationId: installation.id }));
        if (!result.held) return { ok: false, held: false };
        if (!result.result.ok) return { ok: false, held: true, code: result.result.code };
        return { ok: true, operation: await advance(), installation };
      }
      case "stage_contributions": {
        const result = await this.invoke(step, installation, operation, hold, () =>
          this.dependencies.contributionStaging.detach({ effect, installationId: installation.id }));
        if (!result.held) return { ok: false, held: false };
        if (!result.result.ok) return { ok: false, held: true, code: result.result.code };
        return { ok: true, operation: await advance(), installation };
      }
      default:
        return { ok: true, operation: await advance(), installation };
    }
  }

  /**
   * A rollback that finished undid everything the operation committed, so the installation
   * is what it was before the operation started — not damaged.
   *
   * `failed` is what an operator has to repair, and reserving it for the case a rollback
   * could *not* finish is what makes it mean that. A transient provider outage during a
   * first activation would otherwise permanently strand the installation: `activate` is
   * only issuable from `planned`, so one failed attempt would leave removal and
   * reinstallation as the only way back.
   *
   * The health record is written either way, because a code and a message are what an
   * operator reads to know why the attempt did not take.
   */
  private async restoreSourceState(
    repositories: AppsTransactionalRepositories,
    workspaceId: string,
    operation: AppLifecycleOperationRecord,
    installation: AppInstallationRecord,
    failure: { readonly reason: string; readonly message: string },
  ): Promise<AppInstallationRecord> {
    if (kindsThatPreserveTheInstallation.has(operation.kind)) return installation;
    const source = readSourceState(operation.payload);
    // Removal's steps revoke grants, mark credentials for deletion, and dispose of data;
    // none of them is reversible, so there is no earlier state to return to. The
    // installation stays where it stopped, still fenced against execution, and removal is
    // reissuable against it.
    const restores = source !== null
      && kindsThatRestoreTheirSourceState.has(operation.kind)
      && (source === installation.state || canTransitionAppInstallation(installation.state, source));
    const restored = await repositories.installations.update(
      workspaceId,
      installation.id,
      installation.version,
      {
        ...(restores
          ? {
            state: source,
            // Whatever this operation closed, it closed for work that has now been undone.
            // A disable that could not stop the runtime must not leave an installation that
            // reads as active and refuses every invocation.
            executionDeniedAt: null,
          }
          : {}),
        health: { reason: failure.reason, message: failure.message },
      },
    );
    return restored ?? installation;
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

/** The installation state the command was issued against, if this operation recorded one. */
const readSourceState = (payload: Readonly<Record<string, unknown>>): AppInstallationState | null => {
  const value = payload.sourceState;
  return typeof value === "string" && (appInstallationStates as readonly string[]).includes(value)
    ? value as AppInstallationState
    : null;
};

const readDisposition = (value: unknown): AppDataDisposition =>
  value === "export" || value === "delete" ? value : "retain";

const readConfiguration = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
