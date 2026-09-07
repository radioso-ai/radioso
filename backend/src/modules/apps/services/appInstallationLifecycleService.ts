import { notFound } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import { AppsError } from "../domain/errors.js";
import {
  appSagaCompensationPlan,
  assertAppInstallationTransition,
  remainingAppSagaSteps,
  type AppInstallationState,
  type AppLifecycleOperationKind,
  type AppSagaStep,
} from "../domain/lifecycle.js";
import { assertAppPlanApplicable, type AppInstallationPlan } from "../domain/installationPlan.js";
import type { AppInstallationRecord, AppLifecycleOperationRecord } from "../domain/records.js";
import type { AppContributionStagingPort } from "../ports/contributionStaging.js";
import type { AppDataDisposition, AppManagedDataDispositionPort } from "../ports/managedDataDisposition.js";
import type { AppOperatorAuthorizationPort, AppOperatorPrincipal } from "../ports/operatorAuthorization.js";
import type { AppRuntimeProvisioningPort } from "../ports/runtimeProvisioning.js";
import type { AppConnectionRepositoryPort } from "../repositories/appConnectionRepository.js";
import type { AppGrantRepositoryPort } from "../repositories/appGrantRepository.js";
import type { AppInstallationPlanRepositoryPort } from "../repositories/appInstallationPlanRepository.js";
import type { AppInstallationRepositoryPort } from "../repositories/appInstallationRepository.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";
import type { AppLifecycleOperationRepositoryPort } from "../repositories/appLifecycleOperationRepository.js";

interface AppInstallationLifecycleDependencies {
  readonly installations: AppInstallationRepositoryPort;
  readonly plans: AppInstallationPlanRepositoryPort;
  readonly releases: AppReleaseRepositoryPort;
  readonly grants: AppGrantRepositoryPort;
  readonly connections: AppConnectionRepositoryPort;
  readonly operations: AppLifecycleOperationRepositoryPort;
  readonly runtimeProvisioning: AppRuntimeProvisioningPort;
  readonly contributionStaging: AppContributionStagingPort;
  readonly dataDisposition: AppManagedDataDispositionPort;
  readonly authorization: AppOperatorAuthorizationPort;
  readonly audit: Pick<AuditPort, "record">;
  readonly logger: AppLogger;
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
  readonly idempotencyKey: string;
  readonly principal: AppOperatorPrincipal;
}

interface RemoveAppInstallationRequest extends AppLifecycleCommandRequest {
  readonly disposition: AppDataDisposition;
}

export interface AppLifecycleOutcome {
  readonly installation: AppInstallationRecord;
  readonly operation: AppLifecycleOperationRecord;
}

const completionAuditEvent: Readonly<Record<AppLifecycleOperationKind, string>> = {
  install: "app.installation.installed",
  disable: "app.installation.disabled",
  enable: "app.installation.enabled",
  remove: "app.installation.removed",
  dispose_data: "app.installation.removed",
};

/**
 * The durable half of the Apps control plane: apply, disable, enable, remove, and data
 * disposition all run as the same saga over `app_lifecycle_operations`. Each step is
 * idempotent, commits a cursor, and re-checks the initiating principal before it starts,
 * so a resumed operation cannot mint a new privileged effect on lapsed authority.
 */
export class AppInstallationLifecycleService {
  constructor(private readonly dependencies: AppInstallationLifecycleDependencies) {}

  private now(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }

  async apply(request: ApplyAppInstallationPlanRequest): Promise<AppLifecycleOutcome> {
    await this.dependencies.authorization.requireAppAdministration(request.principal, request.workspaceId);

    const resumed = await this.dependencies.operations.findByIdempotencyKey(request.idempotencyKey);
    if (resumed) return this.resume(request.workspaceId, resumed);

    const planRecord = await this.dependencies.plans.findById(request.workspaceId, request.planId);
    if (!planRecord) throw notFound("App installation plan not found");
    const plan = planRecord.plan;

    const existing = await this.dependencies.installations.findLiveByAppId(request.workspaceId, plan.appId);
    assertAppPlanApplicable({
      plan: planRecord,
      submittedChecksum: request.checksum,
      expectedInstallationVersion: request.expectedInstallationVersion,
      currentInstallationVersion: existing?.version ?? null,
      now: this.now(),
    });

    if (plan.unresolvedRequirements.length > 0) {
      throw new AppsError("invalid_configuration", "This plan still has unresolved requirements.", {
        unresolvedRequirementCount: plan.unresolvedRequirements.length,
      });
    }
    if (existing) {
      throw new AppsError("installation_conflict", "This App is already installed in this workspace.", {
        installationId: existing.id,
      });
    }

    // Claim the plan before creating anything: two concurrent applies of one approval
    // must produce one installation, and the loser must see a stale plan.
    if (!(await this.dependencies.plans.consume(request.workspaceId, planRecord.id, this.now()))) {
      throw new AppsError("plan_stale", "This plan has already been applied.", { cause: "consumed" });
    }

    const installation = await this.dependencies.installations.create({
      workspaceId: request.workspaceId,
      appId: plan.appId,
      candidateReleaseId: plan.releaseId,
      configuration: plan.configuration,
    });

    await this.guardNoConcurrentOperation(installation.id, request.idempotencyKey);
    const { operation } = await this.dependencies.operations.start({
      installationId: installation.id,
      kind: "install",
      idempotencyKey: request.idempotencyKey,
      initiatedBy: request.principal,
      payload: { planId: planRecord.id, checksum: planRecord.checksum, releaseId: plan.releaseId },
    });

    return this.run(request.workspaceId, operation, installation, plan);
  }

  disable(request: AppLifecycleCommandRequest): Promise<AppLifecycleOutcome> {
    return this.command(request, "disable", {});
  }

  enable(request: AppLifecycleCommandRequest): Promise<AppLifecycleOutcome> {
    return this.command(request, "enable", {});
  }

  remove(request: RemoveAppInstallationRequest): Promise<AppLifecycleOutcome> {
    return this.command(request, "remove", { disposition: request.disposition });
  }

  /**
   * Re-drives an operation left running by a crash. Safe to call repeatedly: the cursor
   * decides what is still owed.
   */
  async resumeById(workspaceId: string, operationId: string): Promise<AppLifecycleOutcome> {
    const operation = await this.dependencies.operations.findById(operationId);
    if (!operation) throw notFound("App lifecycle operation not found");
    return this.resume(workspaceId, operation);
  }

  private async command(
    request: AppLifecycleCommandRequest,
    kind: AppLifecycleOperationKind,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<AppLifecycleOutcome> {
    await this.dependencies.authorization.requireAppAdministration(request.principal, request.workspaceId);

    const resumed = await this.dependencies.operations.findByIdempotencyKey(request.idempotencyKey);
    if (resumed) return this.resume(request.workspaceId, resumed);

    const installation = await this.loadInstallation(request.workspaceId, request.installationId);
    await this.guardNoConcurrentOperation(installation.id, request.idempotencyKey);
    const { operation } = await this.dependencies.operations.start({
      installationId: installation.id,
      kind,
      idempotencyKey: request.idempotencyKey,
      initiatedBy: request.principal,
      payload,
    });
    return this.run(request.workspaceId, operation, installation, null);
  }

  /**
   * Fast-fails a command against an installation that already has a saga mid-flight,
   * instead of letting two operations race the same installation row. A retry that
   * carries the in-flight operation's own idempotency key is not a second operation — the
   * `findByIdempotencyKey` check above already routes that case to `resume`, so this only
   * ever sees a genuinely different command.
   */
  private async guardNoConcurrentOperation(installationId: string, idempotencyKey: string): Promise<void> {
    const active = await this.dependencies.operations.findActiveByInstallation(installationId);
    if (active && active.idempotencyKey !== idempotencyKey) {
      throw new AppsError(
        "operation_in_progress",
        "Another lifecycle operation is already running for this installation.",
        { operationId: active.id, operationKind: active.kind },
      );
    }
  }

  private async resume(workspaceId: string, operation: AppLifecycleOperationRecord): Promise<AppLifecycleOutcome> {
    const installation = await this.loadInstallation(workspaceId, operation.installationId);
    if (operation.state === "completed" || operation.state === "failed") return { installation, operation };
    const planRecord = typeof operation.payload.planId === "string"
      ? await this.dependencies.plans.findById(workspaceId, operation.payload.planId)
      : null;
    return this.run(workspaceId, operation, installation, planRecord?.plan ?? null);
  }

  private async loadInstallation(workspaceId: string, installationId: string): Promise<AppInstallationRecord> {
    const installation = await this.dependencies.installations.findById(workspaceId, installationId);
    if (!installation) throw notFound("App installation not found");
    return installation;
  }

  private async run(
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
      try {
        await this.dependencies.authorization.requireAppAdministration(operation.initiatedBy, workspaceId);
      } catch {
        return this.abandon(
          workspaceId,
          operation,
          installation,
          new AppsError(
            "initiating_principal_unauthorized",
            "The operator who started this operation can no longer administer Apps in this workspace. A currently authorized operator must approve a new plan.",
          ),
        );
      }

      try {
        installation = await this.executeStep(step, workspaceId, installation, operation, plan);
        operation = await this.dependencies.operations.update(operation.id, { step: step.id });
      } catch (error) {
        return this.abandon(workspaceId, operation, installation, error);
      }
    }

    operation = await this.dependencies.operations.update(operation.id, { state: "completed", error: null });
    await this.dependencies.audit.record({
      accountId: operation.initiatedBy.accountId,
      workspaceId,
      eventType: completionAuditEvent[operation.kind],
      eventStatus: "success",
      metadata: {
        installationId: installation.id,
        appId: installation.appId,
        operationId: operation.id,
        operationKind: operation.kind,
        state: installation.state,
        releaseId: installation.activeReleaseId,
      },
    });
    return { installation, operation };
  }

  private async executeStep(
    step: AppSagaStep,
    workspaceId: string,
    installation: AppInstallationRecord,
    operation: AppLifecycleOperationRecord,
    plan: AppInstallationPlan | null,
  ): Promise<AppInstallationRecord> {
    switch (step.id) {
      case "create_records":
        break;
      case "persist_grants_and_connections": {
        // Connections are bound by explicit operator action against an existing
        // installation, so at first install there are none to confirm; the grants the
        // operator approved are what this step commits.
        if (plan) {
          await this.dependencies.grants.approve({
            installationId: installation.id,
            releaseId: plan.releaseId,
            planId: typeof operation.payload.planId === "string" ? operation.payload.planId : null,
            approvedBy: operation.initiatedBy.userId,
            grants: plan.grants,
          });
          await this.dependencies.audit.record({
            accountId: operation.initiatedBy.accountId,
            workspaceId,
            eventType: "app.grant.approved",
            eventStatus: "success",
            metadata: {
              installationId: installation.id,
              appId: installation.appId,
              releaseId: plan.releaseId,
              grantCount: plan.grants.length,
              operationId: operation.id,
            },
          });
        }
        break;
      }
      case "provision_runtime":
        await this.dependencies.runtimeProvisioning.provision(await this.provisioningRequest(installation));
        break;
      case "stage_contributions":
        await this.dependencies.contributionStaging.stage(await this.stagingRequest(installation, plan));
        break;
      case "run_safe_tests":
        await this.dependencies.contributionStaging.runSafeTests(await this.stagingRequest(installation, plan));
        break;
      case "mark_ready":
        break;
      case "activate":
        return this.transition(workspaceId, installation, "active", {
          activeReleaseId: installation.candidateReleaseId ?? installation.activeReleaseId,
          candidateReleaseId: null,
        });
      case "stop_runtime":
        await this.dependencies.runtimeProvisioning.deprovision({ installationId: installation.id });
        break;
      case "mark_disabled":
        break;
      case "revoke_grants": {
        const revoked = await this.dependencies.grants.revokeAll(installation.id, this.now());
        await this.dependencies.audit.record({
          accountId: operation.initiatedBy.accountId,
          workspaceId,
          eventType: "app.grant.revoked",
          eventStatus: "success",
          metadata: {
            installationId: installation.id,
            appId: installation.appId,
            grantCount: revoked,
            operationId: operation.id,
          },
        });
        break;
      }
      case "mark_connections_for_deletion":
        await this.dependencies.connections.markAllForDeletion(installation.id, this.now());
        break;
      case "detach_contributions":
        await this.dependencies.contributionStaging.detach({ installationId: installation.id });
        break;
      case "dispose_data":
        await this.dependencies.dataDisposition.dispose({
          workspaceId,
          installationId: installation.id,
          disposition: readDisposition(operation.payload.disposition),
        });
        break;
      case "mark_removed":
        break;
    }

    return step.enters === null ? installation : this.transition(workspaceId, installation, step.enters, {});
  }

  private async provisioningRequest(installation: AppInstallationRecord) {
    const releaseId = installation.candidateReleaseId ?? installation.activeReleaseId;
    const release = releaseId ? await this.dependencies.releases.findById(releaseId) : null;
    if (!release) throw notFound("App release not found");
    return {
      installationId: installation.id,
      releaseId: release.id,
      appId: release.appId,
      version: release.version,
    };
  }

  private async stagingRequest(installation: AppInstallationRecord, plan: AppInstallationPlan | null) {
    const releaseId = installation.candidateReleaseId ?? installation.activeReleaseId;
    if (plan) {
      return {
        installationId: installation.id,
        releaseId: plan.releaseId,
        contributionIds: plan.contributions.map((contribution) => contribution.id),
      };
    }
    const release = releaseId ? await this.dependencies.releases.findById(releaseId) : null;
    if (!release) throw notFound("App release not found");
    return {
      installationId: installation.id,
      releaseId: release.id,
      contributionIds: release.manifest.contributions.map((contribution) => contribution.id),
    };
  }

  private async transition(
    workspaceId: string,
    installation: AppInstallationRecord,
    state: AppInstallationState,
    mutation: { activeReleaseId?: string | null; candidateReleaseId?: string | null },
  ): Promise<AppInstallationRecord> {
    assertAppInstallationTransition(installation.state, state);
    const updated = await this.dependencies.installations.update(
      workspaceId,
      installation.id,
      installation.version,
      { state, ...mutation },
    );
    if (!updated) {
      throw new AppsError("plan_stale", "The installation changed while this operation was running.", {
        cause: "version_mismatch",
      });
    }
    if (state === "active") {
      await this.dependencies.audit.record({
        accountId: null,
        workspaceId,
        eventType: "app.installation.activated",
        eventStatus: "success",
        metadata: {
          installationId: updated.id,
          appId: updated.appId,
          releaseId: updated.activeReleaseId,
        },
      });
    }
    return updated;
  }

  /**
   * Compensates what committed, in reverse, skipping every step whose effect cannot be
   * safely reversed, then records the failure. Compensation is system-owned safety work
   * and runs even when the initiating principal has lost access.
   */
  private async abandon(
    workspaceId: string,
    startingOperation: AppLifecycleOperationRecord,
    startingInstallation: AppInstallationRecord,
    error: unknown,
  ): Promise<AppLifecycleOutcome> {
    const reason = error instanceof AppsError ? error.reason : "internal";
    const message = error instanceof Error ? error.message : "App lifecycle operation failed";
    let installation = startingInstallation;

    const operation = await this.dependencies.operations.update(startingOperation.id, { state: "compensating" });
    for (const step of appSagaCompensationPlan(operation.kind, operation.step)) {
      try {
        await this.compensateStep(step, installation);
      } catch (compensationError) {
        this.dependencies.logger.error(
          { err: compensationError, installationId: installation.id, operationId: operation.id, step: step.id },
          "App lifecycle compensation step failed",
        );
      }
    }

    if (installation.state !== "removed" && installation.state !== "failed") {
      const failed = await this.dependencies.installations.update(
        workspaceId,
        installation.id,
        installation.version,
        { state: "failed", health: { reason, message } },
      );
      if (failed) installation = failed;
    }

    const finished = await this.dependencies.operations.update(operation.id, {
      state: "failed",
      error: { reason, message },
    });

    this.dependencies.logger.warn(
      { installationId: installation.id, operationId: finished.id, operationKind: finished.kind, reason },
      "App lifecycle operation failed",
    );
    await this.dependencies.audit.record({
      accountId: finished.initiatedBy.accountId,
      workspaceId,
      eventType: "app.installation.failed",
      eventStatus: "failure",
      metadata: {
        installationId: installation.id,
        appId: installation.appId,
        operationId: finished.id,
        operationKind: finished.kind,
        step: finished.step,
        reason,
      },
    });

    return { installation, operation: finished };
  }

  private async compensateStep(step: AppSagaStep, installation: AppInstallationRecord): Promise<void> {
    switch (step.id) {
      case "persist_grants_and_connections":
        await this.dependencies.grants.revokeAll(installation.id, this.now());
        break;
      case "provision_runtime":
        await this.dependencies.runtimeProvisioning.deprovision({ installationId: installation.id });
        break;
      case "stage_contributions":
        await this.dependencies.contributionStaging.detach({ installationId: installation.id });
        break;
      default:
        break;
    }
  }
}

const readDisposition = (value: unknown): AppDataDisposition =>
  value === "export" || value === "delete" ? value : "retain";
