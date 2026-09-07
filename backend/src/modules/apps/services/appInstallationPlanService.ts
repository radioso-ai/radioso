import { notFound } from "../../../shared/domain/errors.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import { buildAppInstallationPlan } from "../domain/installationPlan.js";
import type { AppInstallationPlanRecord } from "../domain/records.js";
import type { AppOperatorAuthorizationPort, AppOperatorPrincipal } from "../ports/operatorAuthorization.js";
import type { AppConnectionRepositoryPort } from "../repositories/appConnectionRepository.js";
import type { AppInstallationPlanRepositoryPort } from "../repositories/appInstallationPlanRepository.js";
import type { AppInstallationRepositoryPort } from "../repositories/appInstallationRepository.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";

interface CreateAppInstallationPlanRequest {
  readonly workspaceId: string;
  readonly releaseId: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly targetAgentIds: readonly string[];
  readonly principal: AppOperatorPrincipal;
}

interface AppInstallationPlanServiceDependencies {
  readonly releases: AppReleaseRepositoryPort;
  readonly installations: AppInstallationRepositoryPort;
  readonly connections: AppConnectionRepositoryPort;
  readonly plans: AppInstallationPlanRepositoryPort;
  readonly authorization: AppOperatorAuthorizationPort;
  readonly audit: Pick<AuditPort, "record">;
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
    await this.dependencies.authorization.requireAppAdministration(request.principal, request.workspaceId);

    const release = await this.dependencies.releases.findById(request.releaseId);
    if (!release || release.state !== "admitted") throw notFound("App release not found");

    const existing = await this.dependencies.installations.findLiveByAppId(request.workspaceId, release.appId);
    const existingConnections = existing
      ? await this.dependencies.connections.listByInstallation(existing.id)
      : [];

    // A `generated_secret` slot needs nothing from the operator: the host mints it on an
    // explicit, audited bind. Counting it as satisfied here is what keeps planning from
    // demanding a value that only the host can produce.
    const hostMintedSlotIds = release.manifest.connections.slots
      .filter((slot) => slot.kind === "generated_secret")
      .map((slot) => slot.id);

    const { plan, checksum, expiresAt } = buildAppInstallationPlan({
      workspaceId: request.workspaceId,
      release: {
        id: release.id,
        appId: release.appId,
        version: release.version,
        manifestDigest: release.manifestDigest,
        manifest: release.manifest,
      },
      configuration: request.configuration,
      boundConnectionSlotIds: [
        ...hostMintedSlotIds,
        ...existingConnections.map((connection) => connection.slotId),
      ],
      targetAgentIds: request.targetAgentIds,
      now: this.now(),
    });

    const record = await this.dependencies.plans.create({
      workspaceId: request.workspaceId,
      releaseId: release.id,
      checksum,
      plan,
      createdBy: request.principal.userId,
      expiresAt,
    });

    await this.dependencies.audit.record({
      accountId: request.principal.accountId,
      workspaceId: request.workspaceId,
      eventType: "app.installation.planned",
      eventStatus: "success",
      metadata: {
        planId: record.id,
        appId: release.appId,
        releaseId: release.id,
        version: release.version,
        checksum,
        grantCount: plan.grants.length,
        destinationCount: plan.destinations.length,
        contributionCount: plan.contributions.length,
        unresolvedRequirementCount: plan.unresolvedRequirements.length,
      },
    });

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
    await this.dependencies.authorization.requireAppAdministration(principal, workspaceId);

    const record = await this.dependencies.plans.findById(workspaceId, planId);
    if (!record) throw notFound("App installation plan not found");
    return record;
  }
}
