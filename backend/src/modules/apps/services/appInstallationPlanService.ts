import { notFound } from "../../../shared/domain/errors.js";
import { requireAppAdministration } from "../domain/authorization.js";
import { buildAppInstallationPlan } from "../domain/installationPlan.js";
import type { AppInstallationPlanRecord } from "../domain/records.js";
import { assertAppReleaseEligible } from "../domain/releaseAdmission.js";
import type { AppOperatorAuthorizationPort, AppOperatorPrincipal } from "../ports/operatorAuthorization.js";
import type { AppConnectionRepositoryPort } from "../repositories/appConnectionRepository.js";
import type { AppInstallationPlanRepositoryPort } from "../repositories/appInstallationPlanRepository.js";
import type { AppInstallationRepositoryPort } from "../repositories/appInstallationRepository.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";
import type { AppsUnitOfWork } from "../repositories/appsUnitOfWork.js";

interface CreateAppInstallationPlanRequest {
  readonly workspaceId: string;
  readonly releaseId: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly principal: AppOperatorPrincipal;
}

interface AppInstallationPlanServiceDependencies {
  readonly releases: AppReleaseRepositoryPort;
  readonly installations: AppInstallationRepositoryPort;
  readonly connections: AppConnectionRepositoryPort;
  readonly plans: AppInstallationPlanRepositoryPort;
  readonly unitOfWork: AppsUnitOfWork;
  readonly authorization: AppOperatorAuthorizationPort;
  readonly auditDelivery: { drain(): Promise<number> };
  readonly runningRadiosoVersion: string | null;
  readonly clock?: () => Date;
}

export class AppInstallationPlanService {
  constructor(private readonly dependencies: AppInstallationPlanServiceDependencies) {}

  private now(): Date {
    return this.dependencies.clock?.() ?? new Date();
  }

  /**
   * Planning is a read that produces an approvable artifact, and it re-checks the
   * principal because what an operator is shown here is what apply will bind to.
   */
  async create(request: CreateAppInstallationPlanRequest): Promise<AppInstallationPlanRecord> {
    await requireAppAdministration(this.dependencies.authorization, request.principal, request.workspaceId);

    const release = await this.dependencies.releases.findById(request.releaseId);
    if (!release) throw notFound("App release not found");
    assertAppReleaseEligible(release, this.dependencies.runningRadiosoVersion);

    const existing = await this.dependencies.installations.findLiveByAppId(request.workspaceId, release.appId);
    const existingConnections = existing
      ? await this.dependencies.connections.listByInstallation(existing.id)
      : [];

    const { plan, checksum, expiresAt } = buildAppInstallationPlan({
      workspaceId: request.workspaceId,
      release: {
        id: release.id,
        appId: release.appId,
        version: release.version,
        manifestDigest: release.manifestDigest,
        manifest: release.manifest,
        state: release.state,
        admissionPolicyVersion: release.admissionPolicyVersion,
      },
      configuration: request.configuration,
      // A slot counts as bound when a connection record exists for it, and never
      // otherwise. A host-minted secret is bound by the bind that mints it, which is why
      // the plan can show it as an open requirement and the setup phase closes it.
      boundConnectionSlotIds: existingConnections
        .filter((connection) => connection.deletionRequestedAt === null)
        .map((connection) => connection.slotId),
      now: this.now(),
    });

    // The plan row and the record that it was created commit together, so a review an
    // operator was shown is never a review with no audit trail.
    const record = await this.dependencies.unitOfWork.run(async (repositories) => {
      const created = await repositories.plans.create({
        workspaceId: request.workspaceId,
        releaseId: release.id,
        checksum,
        plan,
        createdBy: request.principal.userId,
        expiresAt,
      });
      await repositories.auditOutbox.enqueue([{
        workspaceId: request.workspaceId,
        accountId: request.principal.accountId,
        eventType: "app.installation.planned",
        eventStatus: "success",
        metadata: {
          planId: created.id,
          appId: release.appId,
          releaseId: release.id,
          version: release.version,
          checksum,
          actorUserId: request.principal.userId,
          grantCount: plan.grants.length,
          destinationCount: plan.destinations.length,
          contributionCount: plan.contributions.length,
          unresolvedRequirementCount: plan.unresolvedRequirements.length,
        },
      }]);
      return created;
    });
    await this.dependencies.auditDelivery.drain();

    return record;
  }

  /**
   * Reading a plan back is a protected read, not a free one (FR-027a): it is the document
   * an operator approves, so the principal must still hold App administration when it is
   * shown, not only when it was built.
   */
  async get(
    workspaceId: string,
    planId: string,
    principal: AppOperatorPrincipal,
  ): Promise<AppInstallationPlanRecord> {
    await requireAppAdministration(this.dependencies.authorization, principal, workspaceId);

    const record = await this.dependencies.plans.findById(workspaceId, planId);
    if (!record) throw notFound("App installation plan not found");
    return record;
  }
}
