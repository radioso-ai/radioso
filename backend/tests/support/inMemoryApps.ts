import { randomUUID } from "node:crypto";

import type {
  AppConnectionRecord,
  AppConnectionRepositoryPort,
  AppGrantRecord,
  AppGrantRepositoryPort,
  AppInstallationPlanRecord,
  AppInstallationPlanRepositoryPort,
  AppInstallationRecord,
  AppInstallationRepositoryPort,
  AppInstallationState,
  AppLifecycleOperationRecord,
  AppLifecycleOperationRepositoryPort,
  AppReleaseRecord,
  AppReleaseRepositoryPort,
  AppsUnitOfWork,
} from "../../src/modules/apps/public.js";
import { AppsError } from "../../src/modules/apps/public.js";

/**
 * In-memory Apps persistence for route and service tests. It mirrors the Postgres
 * repositories' contract — optimistic version, plan single-consumption, idempotency-key
 * uniqueness, live-grant uniqueness — because those are the behaviours the saga leans on.
 */
export class InMemoryAppReleaseRepository implements AppReleaseRepositoryPort {
  readonly rows = new Map<string, AppReleaseRecord>();

  async insertIfAbsent(
    input: Parameters<AppReleaseRepositoryPort["insertIfAbsent"]>[0],
  ): Promise<AppReleaseRecord | null> {
    const existing = [...this.rows.values()].find(
      (row) => row.appId === input.appId && row.version === input.version,
    );
    if (existing) return null;
    const record: AppReleaseRecord = {
      id: randomUUID(),
      appId: input.appId,
      version: input.version,
      manifest: input.manifest,
      manifestDigest: input.manifestDigest,
      artifactDigest: input.artifactDigest,
      publisherId: input.publisherId,
      state: input.state,
      admissionPolicyVersion: input.admissionPolicyVersion,
      admissionDecision: input.admissionDecision,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(record.id, record);
    return record;
  }

  async transitionState(
    id: string,
    state: Parameters<AppReleaseRepositoryPort["transitionState"]>[1],
  ): Promise<AppReleaseRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const updated: AppReleaseRecord = { ...row, state, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async findByAppIdAndVersion(appId: string, version: string): Promise<AppReleaseRecord | null> {
    return [...this.rows.values()].find((row) => row.appId === appId && row.version === version) ?? null;
  }

  async findById(id: string): Promise<AppReleaseRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async listInstallable(): Promise<AppReleaseRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.state === "admitted")
      .sort((left, right) => left.appId.localeCompare(right.appId));
  }
}

export class InMemoryAppInstallationRepository implements AppInstallationRepositoryPort {
  readonly rows = new Map<string, AppInstallationRecord>();

  async create(input: Parameters<AppInstallationRepositoryPort["create"]>[0]): Promise<AppInstallationRecord> {
    const record: AppInstallationRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      appId: input.appId,
      activeReleaseId: null,
      candidateReleaseId: input.candidateReleaseId,
      state: "planned" satisfies AppInstallationState,
      configuration: input.configuration,
      version: 1,
      health: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(record.id, record);
    return record;
  }

  async findById(workspaceId: string, id: string): Promise<AppInstallationRecord | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? row : null;
  }

  async findAnyById(id: string): Promise<AppInstallationRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findLiveByAppId(workspaceId: string, appId: string): Promise<AppInstallationRecord | null> {
    return [...this.rows.values()].find(
      (row) => row.workspaceId === workspaceId && row.appId === appId && row.state !== "removed",
    ) ?? null;
  }

  async listByWorkspace(workspaceId: string): Promise<AppInstallationRecord[]> {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId && row.state !== "removed");
  }

  async update(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    mutation: Parameters<AppInstallationRepositoryPort["update"]>[3],
  ): Promise<AppInstallationRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.version !== expectedVersion) return null;
    const updated: AppInstallationRecord = {
      ...row,
      ...(mutation.state === undefined ? {} : { state: mutation.state }),
      ...(mutation.activeReleaseId === undefined ? {} : { activeReleaseId: mutation.activeReleaseId }),
      ...(mutation.candidateReleaseId === undefined ? {} : { candidateReleaseId: mutation.candidateReleaseId }),
      ...(mutation.configuration === undefined ? {} : { configuration: mutation.configuration }),
      ...(mutation.health === undefined ? {} : { health: mutation.health }),
      version: expectedVersion + 1,
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }
}

export class InMemoryAppInstallationPlanRepository implements AppInstallationPlanRepositoryPort {
  readonly rows = new Map<string, AppInstallationPlanRecord>();

  async create(input: Parameters<AppInstallationPlanRepositoryPort["create"]>[0]): Promise<AppInstallationPlanRecord> {
    const record: AppInstallationPlanRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      releaseId: input.releaseId,
      checksum: input.checksum,
      plan: input.plan,
      createdBy: input.createdBy,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      consumedAt: null,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async findById(workspaceId: string, id: string): Promise<AppInstallationPlanRecord | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? row : null;
  }

  async consume(workspaceId: string, id: string, consumedAt: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.consumedAt !== null) return false;
    this.rows.set(id, { ...row, consumedAt });
    return true;
  }
}

export class InMemoryAppGrantRepository implements AppGrantRepositoryPort {
  readonly rows: AppGrantRecord[] = [];

  async approve(input: Parameters<AppGrantRepositoryPort["approve"]>[0]): Promise<void> {
    for (const grant of input.grants) {
      const live = this.rows.some(
        (row) => row.installationId === input.installationId
          && row.releaseId === input.releaseId
          && row.kind === grant.kind
          && row.key === grant.key
          && row.revokedAt === null,
      );
      if (live) continue;
      this.rows.push({
        id: randomUUID(),
        installationId: input.installationId,
        releaseId: input.releaseId,
        kind: grant.kind,
        key: grant.key,
        planId: input.planId,
        approvedBy: input.approvedBy,
        approvedAt: new Date(),
        revokedAt: null,
      });
    }
  }

  async listLive(installationId: string): Promise<AppGrantRecord[]> {
    return this.rows.filter((row) => row.installationId === installationId && row.revokedAt === null);
  }

  async revokeAll(installationId: string, revokedAt: Date): Promise<number> {
    let revoked = 0;
    this.rows.forEach((row, index) => {
      if (row.installationId !== installationId || row.revokedAt !== null) return;
      this.rows[index] = { ...row, revokedAt };
      revoked += 1;
    });
    return revoked;
  }
}

export class InMemoryAppConnectionRepository implements AppConnectionRepositoryPort {
  readonly rows: Array<AppConnectionRecord & { secretCiphertext: string | null }> = [];

  async bind(input: Parameters<AppConnectionRepositoryPort["bind"]>[0]): Promise<AppConnectionRecord> {
    const now = new Date();
    const index = this.rows.findIndex(
      (row) => row.installationId === input.installationId && row.slotId === input.slotId,
    );
    const record = {
      id: index >= 0 ? this.rows[index].id : randomUUID(),
      installationId: input.installationId,
      slotId: input.slotId,
      kind: input.kind,
      publicFields: input.publicFields,
      hasSecret: input.secretCiphertext !== null,
      secretCiphertext: input.secretCiphertext,
      createdAt: index >= 0 ? this.rows[index].createdAt : now,
      updatedAt: now,
      rotatedAt: index >= 0 ? now : null,
      // Never cleared by a rebind: a connection marked for deletion belongs to an
      // installation that is being removed.
      deletionRequestedAt: index >= 0 ? this.rows[index].deletionRequestedAt : null,
    };
    if (index >= 0) this.rows[index] = record;
    else this.rows.push(record);
    const { secretCiphertext: _ciphertext, ...safe } = record;
    return safe;
  }

  async listByInstallation(installationId: string): Promise<AppConnectionRecord[]> {
    return this.rows
      .filter((row) => row.installationId === installationId)
      .map(({ secretCiphertext: _ciphertext, ...safe }) => safe);
  }

  async markAllForDeletion(installationId: string, requestedAt: Date): Promise<number> {
    let marked = 0;
    this.rows.forEach((row, index) => {
      if (row.installationId !== installationId || row.deletionRequestedAt !== null) return;
      this.rows[index] = { ...row, deletionRequestedAt: requestedAt };
      marked += 1;
    });
    return marked;
  }
}

export class InMemoryAppLifecycleOperationRepository implements AppLifecycleOperationRepositoryPort {
  readonly rows = new Map<string, AppLifecycleOperationRecord>();

  async start(input: Parameters<AppLifecycleOperationRepositoryPort["start"]>[0]) {
    const existing = [...this.rows.values()].find((row) => row.idempotencyKey === input.idempotencyKey);
    if (existing) return { operation: existing, created: false };
    // Mirrors migration 171's partial unique index: one in-flight operation per
    // installation, and its violation reads as `operation_in_progress`.
    const inFlight = [...this.rows.values()].some(
      (row) => row.installationId === input.installationId
        && (row.state === "running" || row.state === "compensating"),
    );
    if (inFlight) {
      throw new AppsError(
        "operation_in_progress",
        "Another lifecycle operation is already running for this installation.",
        { installationId: input.installationId },
      );
    }
    const record: AppLifecycleOperationRecord = {
      id: randomUUID(),
      installationId: input.installationId,
      kind: input.kind,
      state: "running",
      step: null,
      compensationStep: null,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      initiatedBy: input.initiatedBy,
      payload: input.payload,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(record.id, record);
    return { operation: record, created: true };
  }

  async findById(id: string): Promise<AppLifecycleOperationRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async update(
    id: string,
    mutation: Parameters<AppLifecycleOperationRepositoryPort["update"]>[1],
  ): Promise<AppLifecycleOperationRecord> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`unknown app lifecycle operation ${id}`);
    const updated: AppLifecycleOperationRecord = {
      ...row,
      ...(mutation.state === undefined ? {} : { state: mutation.state }),
      ...(mutation.step === undefined ? {} : { step: mutation.step }),
      ...(mutation.compensationStep === undefined ? {} : { compensationStep: mutation.compensationStep }),
      ...(mutation.error === undefined ? {} : { error: mutation.error }),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async advance(
    id: string,
    input: Parameters<AppLifecycleOperationRepositoryPort["advance"]>[1],
  ): Promise<AppLifecycleOperationRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.state !== input.expectedState || row.step !== input.expectedStep) return null;
    const updated: AppLifecycleOperationRecord = { ...row, step: input.step, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async advanceCompensation(
    id: string,
    input: Parameters<AppLifecycleOperationRepositoryPort["advanceCompensation"]>[1],
  ): Promise<AppLifecycleOperationRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.state !== "compensating" || row.compensationStep !== input.expectedCompensationStep) return null;
    const updated: AppLifecycleOperationRecord = {
      ...row,
      compensationStep: input.compensationStep,
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async listByInstallation(installationId: string, limit: number): Promise<AppLifecycleOperationRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.installationId === installationId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<AppLifecycleOperationRecord | null> {
    return [...this.rows.values()].find((row) => row.idempotencyKey === idempotencyKey) ?? null;
  }

  async findActiveByInstallation(installationId: string): Promise<AppLifecycleOperationRecord | null> {
    const active = [...this.rows.values()]
      .filter((row) => row.installationId === installationId && (row.state === "running" || row.state === "compensating"))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return active[0] ?? null;
  }
}

export interface InMemoryAppRepositories {
  readonly releases: InMemoryAppReleaseRepository;
  readonly installations: InMemoryAppInstallationRepository;
  readonly plans: InMemoryAppInstallationPlanRepository;
  readonly grants: InMemoryAppGrantRepository;
  readonly connections: InMemoryAppConnectionRepository;
  readonly operations: InMemoryAppLifecycleOperationRepository;
}

/**
 * The in-memory repositories share one object graph, so running work "in a transaction"
 * is running it against the same repositories. What this double cannot reproduce is
 * rollback, so a test that needs to prove atomicity uses the integration suite.
 */
export const createInMemoryAppsUnitOfWork = (repositories: InMemoryAppRepositories): AppsUnitOfWork => ({
  run: (work) => work(repositories),
});

export const createInMemoryAppRepositories = (): InMemoryAppRepositories => ({
  releases: new InMemoryAppReleaseRepository(),
  installations: new InMemoryAppInstallationRepository(),
  plans: new InMemoryAppInstallationPlanRepository(),
  grants: new InMemoryAppGrantRepository(),
  connections: new InMemoryAppConnectionRepository(),
  operations: new InMemoryAppLifecycleOperationRepository(),
});
