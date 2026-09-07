import { installationReadiness, resolveConfiguration, type EffectiveConfiguration } from "@radioso/app-contract";

import { notFound } from "../../../shared/domain/errors.js";
import { AppsError } from "../domain/errors.js";
import type {
  AppConnectionRecord,
  AppGrantRecord,
  AppInstallationRecord,
  AppLifecycleOperationRecord,
} from "../domain/records.js";
import type { AppOperatorAuthorizationPort, AppOperatorPrincipal } from "../ports/operatorAuthorization.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import type { AppConnectionRepositoryPort } from "../repositories/appConnectionRepository.js";
import type { AppGrantRepositoryPort } from "../repositories/appGrantRepository.js";
import type { AppInstallationRepositoryPort } from "../repositories/appInstallationRepository.js";
import type { AppLifecycleOperationRepositoryPort } from "../repositories/appLifecycleOperationRepository.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";

const OPERATION_HISTORY_LIMIT = 20;

export interface AppInstallationView {
  readonly installation: AppInstallationRecord;
  readonly activeVersion: string | null;
  readonly candidateVersion: string | null;
  readonly grants: readonly AppGrantRecord[];
  readonly connections: readonly AppConnectionRecord[];
  readonly currentOperation: AppLifecycleOperationRecord | null;
}

interface AppInstallationQueryDependencies {
  readonly installations: AppInstallationRepositoryPort;
  readonly releases: AppReleaseRepositoryPort;
  readonly grants: AppGrantRepositoryPort;
  readonly connections: AppConnectionRepositoryPort;
  readonly operations: AppLifecycleOperationRepositoryPort;
  readonly authorization: AppOperatorAuthorizationPort;
  readonly audit: Pick<AuditPort, "record">;
}

export class AppInstallationQueryService {
  constructor(private readonly dependencies: AppInstallationQueryDependencies) {}

  list(workspaceId: string): Promise<AppInstallationRecord[]> {
    return this.dependencies.installations.listByWorkspace(workspaceId);
  }

  async get(workspaceId: string, installationId: string): Promise<AppInstallationView> {
    const installation = await this.dependencies.installations.findById(workspaceId, installationId);
    if (!installation) throw notFound("App installation not found");

    const [grants, connections, operations] = await Promise.all([
      this.dependencies.grants.listLive(installation.id),
      this.dependencies.connections.listByInstallation(installation.id),
      this.dependencies.operations.listByInstallation(installation.id, 1),
    ]);

    return {
      installation,
      activeVersion: await this.versionOf(installation.activeReleaseId),
      candidateVersion: await this.versionOf(installation.candidateReleaseId),
      grants,
      connections,
      currentOperation: operations[0] ?? null,
    };
  }

  listOperations(workspaceId: string, installationId: string): Promise<AppLifecycleOperationRecord[]> {
    return this.dependencies.installations.findById(workspaceId, installationId).then((installation) => {
      if (!installation) throw notFound("App installation not found");
      return this.dependencies.operations.listByInstallation(installation.id, OPERATION_HISTORY_LIMIT);
    });
  }

  /**
   * Release A validates a configuration change against the release's own schema and
   * applies it under an optimistic version. Widening a grant still needs a new plan; a
   * value change inside the approved schema does not.
   */
  async updateConfiguration(request: {
    readonly workspaceId: string;
    readonly installationId: string;
    readonly configuration: Readonly<Record<string, unknown>>;
    readonly expectedVersion: number;
    readonly principal: AppOperatorPrincipal;
  }): Promise<AppInstallationRecord> {
    await this.dependencies.authorization.requireAppAdministration(request.principal, request.workspaceId);

    const installation = await this.dependencies.installations.findById(request.workspaceId, request.installationId);
    if (!installation || installation.state === "removed") throw notFound("App installation not found");

    const releaseId = installation.activeReleaseId ?? installation.candidateReleaseId;
    const release = releaseId ? await this.dependencies.releases.findById(releaseId) : null;
    if (!release) throw notFound("App release not found");

    const resolved = resolveConfiguration(release.manifest, request.configuration);
    if (!resolved.ok) {
      const [issue] = resolved.issues;
      throw new AppsError("invalid_configuration", issue?.message ?? "Configuration is invalid.", {
        field: issue?.path ?? "configuration",
      });
    }
    const configuration = resolved.configuration;

    // Configuration decides which contributions run, so a value change can turn one on.
    // Only what this change newly requires is checked: a slot that was already required
    // and already unbound is the installation's existing state, not something this edit
    // introduced, and refusing here would make an unrelated edit impossible. The stored
    // configuration was itself only ever persisted after resolving successfully against
    // this same, immutable release manifest, so re-resolving it here is expected to
    // succeed; if it somehow does not, there is nothing "already required" to protect and
    // the guard falls back to the safer empty set rather than trusting an unresolved map.
    const requiredSlotsOf = (values: EffectiveConfiguration): readonly string[] =>
      installationReadiness(release.manifest, values).requiredConnectionSlots;
    const storedConfiguration = resolveConfiguration(release.manifest, installation.configuration);
    const alreadyRequired = new Set(storedConfiguration.ok ? requiredSlotsOf(storedConfiguration.configuration) : []);
    const newlyRequired = requiredSlotsOf(configuration).filter((slotId) => !alreadyRequired.has(slotId));
    if (newlyRequired.length > 0) {
      const bound = new Set(
        (await this.dependencies.connections.listByInstallation(installation.id))
          .map((connection) => connection.slotId),
      );
      const unbound = newlyRequired.filter((slotId) => !bound.has(slotId));
      if (unbound.length > 0) {
        throw new AppsError("connection_unbound", "This change turns on a contribution whose connection is not bound yet.", {
          slotId: unbound[0],
        });
      }
    }

    const updated = await this.dependencies.installations.update(
      request.workspaceId,
      installation.id,
      request.expectedVersion,
      { configuration },
    );
    if (!updated) {
      throw new AppsError("plan_stale", "This installation changed since it was read.", { cause: "version_mismatch" });
    }

    await this.dependencies.audit.record({
      accountId: request.principal.accountId,
      workspaceId: request.workspaceId,
      eventType: "app.installation.configuration_updated",
      eventStatus: "success",
      metadata: {
        installationId: updated.id,
        appId: updated.appId,
        change: "configuration",
        // Keys only: a configuration value can be a site URL or a customer identifier.
        configurationKeys: Object.keys(configuration).sort(),
        version: updated.version,
      },
    });

    return updated;
  }

  private async versionOf(releaseId: string | null): Promise<string | null> {
    if (!releaseId) return null;
    const release = await this.dependencies.releases.findById(releaseId);
    return release?.version ?? null;
  }
}
