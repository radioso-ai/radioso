import { notFound } from "../../../shared/domain/errors.js";
import type {
  AppConnectionRecord,
  AppGrantRecord,
  AppInstallationRecord,
  AppLifecycleOperationRecord,
} from "../domain/records.js";
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

  private async versionOf(releaseId: string | null): Promise<string | null> {
    if (!releaseId) return null;
    const release = await this.dependencies.releases.findById(releaseId);
    return release?.version ?? null;
  }
}
