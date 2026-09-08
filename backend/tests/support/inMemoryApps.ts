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
import type { AppAuditIntent, AppAuditOutboxRecord, AppAuditOutboxRepositoryPort } from "../../src/modules/apps/repositories/appAuditOutboxRepository.js";

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

  async lockEligible(input: Parameters<AppReleaseRepositoryPort["lockEligible"]>[0]): Promise<AppReleaseRecord | null> {
    const row = this.rows.get(input.releaseId);
    return row
      && input.allowedStates.includes(row.state)
      && row.admissionPolicyVersion === input.admissionPolicyVersion
      && row.manifestDigest === input.manifestDigest
      ? row
      : null;
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
      candidateConfiguration: null,
      candidateRevision: null,
      executionDeniedAt: null,
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
      ...(mutation.candidateConfiguration === undefined ? {} : { candidateConfiguration: mutation.candidateConfiguration }),
      ...(mutation.candidateRevision === undefined ? {} : { candidateRevision: mutation.candidateRevision }),
      ...(mutation.executionDeniedAt === undefined ? {} : { executionDeniedAt: mutation.executionDeniedAt }),
      ...(mutation.health === undefined ? {} : { health: mutation.health }),
      version: expectedVersion + 1,
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async activateRelease(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    input: Parameters<AppInstallationRepositoryPort["activateRelease"]>[3],
  ): Promise<AppInstallationRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.version !== expectedVersion) return null;
    const updated: AppInstallationRecord = {
      ...row,
      state: "active",
      activeReleaseId: input.releaseId,
      candidateReleaseId: null,
      executionDeniedAt: null,
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

  async consume(input: Parameters<AppInstallationPlanRepositoryPort["consume"]>[0]): Promise<boolean> {
    const row = this.rows.get(input.planId);
    if (!row
      || row.workspaceId !== input.workspaceId
      || row.releaseId !== input.releaseId
      || row.checksum !== input.checksum
      || row.consumedAt !== null
      || row.expiresAt <= input.now) return false;
    this.rows.set(input.planId, { ...row, consumedAt: input.now });
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

  async reserve(input: Parameters<AppLifecycleOperationRepositoryPort["reserve"]>[0]) {
    const existing = [...this.rows.values()].find(
      (row) => row.workspaceId === input.workspaceId && row.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return null;
    // Mirrors migration 171's partial unique index: one in-flight operation per
    // installation, and its violation reads as `operation_in_progress`.
    const inFlight = [...this.rows.values()].some(
      (row) => row.installationId === input.installationId
        && (row.state === "running" || row.state === "compensating" || row.state === "compensation_failed"),
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
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      kind: input.kind,
      state: "running",
      step: null,
      compensationStep: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      initiatedBy: input.initiatedBy,
      payload: input.payload,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(record.id, record);
    return record;
  }

  /** Compatibility helper for tests that need to seed an in-flight operation. */
  async start(input: Omit<Parameters<AppLifecycleOperationRepositoryPort["reserve"]>[0], "workspaceId">) {
    const operation = await this.reserve({ ...input, workspaceId: "22222222-2222-4222-8222-222222222222" });
    if (!operation) {
      const existing = await this.findByIdempotencyKey("22222222-2222-4222-8222-222222222222", input.idempotencyKey);
      return { operation: existing!, created: false };
    }
    return { operation, created: true };
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
      ...(mutation.state === undefined ? {} : { leaseOwner: null, leaseExpiresAt: null }),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async claim(
    id: string,
    input: Parameters<AppLifecycleOperationRepositoryPort["claim"]>[1],
  ): Promise<AppLifecycleOperationRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.state !== input.expectedState || row.step !== input.expectedStep
      || (input.expectedCompensationStep !== undefined && row.compensationStep !== input.expectedCompensationStep)
      || (row.leaseOwner !== null && row.leaseOwner !== input.leaseOwner
        && (row.leaseExpiresAt === null || row.leaseExpiresAt > input.now))) return null;
    const updated = { ...row, leaseOwner: input.leaseOwner, leaseExpiresAt: input.leaseExpiresAt, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async release(id: string, leaseOwner: string): Promise<void> {
    const row = this.rows.get(id);
    if (row?.leaseOwner === leaseOwner) this.rows.set(id, { ...row, leaseOwner: null, leaseExpiresAt: null });
  }

  async advance(
    id: string,
    input: Parameters<AppLifecycleOperationRepositoryPort["advance"]>[1],
  ): Promise<AppLifecycleOperationRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.state !== input.expectedState || row.step !== input.expectedStep || row.leaseOwner !== input.leaseOwner) return null;
    const updated: AppLifecycleOperationRecord = { ...row, step: input.step, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async advanceCompensation(
    id: string,
    input: Parameters<AppLifecycleOperationRepositoryPort["advanceCompensation"]>[1],
  ): Promise<AppLifecycleOperationRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.state !== "compensating" || row.step !== input.expectedStep
      || row.compensationStep !== input.expectedCompensationStep || row.leaseOwner !== input.leaseOwner) return null;
    const updated: AppLifecycleOperationRecord = {
      ...row,
      compensationStep: input.compensationStep,
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async finish(
    id: string,
    input: Parameters<AppLifecycleOperationRepositoryPort["finish"]>[1],
  ): Promise<AppLifecycleOperationRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.state !== input.expectedState || row.step !== input.expectedStep
      || (row.leaseOwner !== input.leaseOwner && !(input.leaseOwner === "" && row.leaseOwner === null))
      || (input.expectedCompensationStep !== undefined && row.compensationStep !== input.expectedCompensationStep)) return null;
    const terminal = input.state !== "running" && input.state !== "compensating";
    const updated = {
      ...row,
      state: input.state,
      error: input.error,
      ...(input.compensationStep === undefined ? {} : { compensationStep: input.compensationStep }),
      ...(terminal ? { leaseOwner: null, leaseExpiresAt: null } : {}),
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

  async findByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<AppLifecycleOperationRecord | null> {
    return [...this.rows.values()].find(
      (row) => row.workspaceId === workspaceId && row.idempotencyKey === idempotencyKey,
    ) ?? null;
  }

  async findActiveByInstallation(installationId: string): Promise<AppLifecycleOperationRecord | null> {
    const active = [...this.rows.values()]
      .filter((row) => row.installationId === installationId
        && (row.state === "running" || row.state === "compensating" || row.state === "compensation_failed"))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return active[0] ?? null;
  }
}

export class InMemoryAppAuditOutboxRepository implements AppAuditOutboxRepositoryPort {
  readonly rows: Array<AppAuditOutboxRecord & { deliveredAt: Date | null }> = [];

  async enqueue(intents: readonly AppAuditIntent[]): Promise<readonly string[]> {
    return intents.map((intent) => {
      const id = randomUUID();
      this.rows.push({ id, intent, deliveredAt: null });
      return id;
    });
  }

  async listUndelivered(limit: number): Promise<AppAuditOutboxRecord[]> {
    return this.rows.filter((row) => row.deliveredAt === null).slice(0, limit);
  }

  async markDelivered(ids: readonly string[], deliveredAt: Date): Promise<void> {
    const wanted = new Set(ids);
    this.rows.forEach((row, index) => {
      if (wanted.has(row.id)) this.rows[index] = { ...row, deliveredAt };
    });
  }
}

export interface InMemoryAppRepositories {
  readonly releases: InMemoryAppReleaseRepository;
  readonly installations: InMemoryAppInstallationRepository;
  readonly plans: InMemoryAppInstallationPlanRepository;
  readonly grants: InMemoryAppGrantRepository;
  readonly connections: InMemoryAppConnectionRepository;
  readonly operations: InMemoryAppLifecycleOperationRepository;
  readonly auditOutbox: InMemoryAppAuditOutboxRepository;
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
  auditOutbox: new InMemoryAppAuditOutboxRepository(),
});
