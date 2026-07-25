import { randomUUID } from "node:crypto";

import type {
  CreateCaseInput,
  CreateRunInput,
  CreateSnapshotInput,
  EvalRepositoryPort,
} from "../../src/modules/eval/services/evalRepository.js";
import type {
  EvalAssertion,
  EvalCase,
  EvalCaseListItem,
  EvalCaseStatus,
  EvalRun,
  EvalSnapshot,
} from "../../src/modules/eval/domain/types.js";

/**
 * Map-backed in-memory {@link EvalRepositoryPort} for tests that exercise eval
 * surfaces (Workbench replay, per-workspace rate limiting) without a real DB.
 * Mirrors the relational repository's contract closely enough for snapshot
 * lookup, case management, and run counting.
 */
export class InMemoryEvalRepository implements EvalRepositoryPort {
  private readonly snapshots = new Map<string, EvalSnapshot>();
  private readonly cases = new Map<string, EvalCase>();
  private readonly runs: EvalRun[] = [];

  constructor(initial?: { snapshots?: EvalSnapshot[]; cases?: EvalCase[] }) {
    for (const s of initial?.snapshots ?? []) this.snapshots.set(s.id, s);
    for (const c of initial?.cases ?? []) this.cases.set(c.id, c);
  }

  async createSnapshot(input: CreateSnapshotInput): Promise<EvalSnapshot> {
    const id = randomUUID();
    const snapshot: EvalSnapshot = {
      id,
      capturedAt: new Date().toISOString(),
      ...input,
    };
    this.snapshots.set(id, snapshot);
    return snapshot;
  }

  async findSnapshot(workspaceId: string, id: string): Promise<EvalSnapshot | null> {
    const snapshot = this.snapshots.get(id);
    return snapshot && snapshot.workspaceId === workspaceId ? snapshot : null;
  }

  async createCase(input: CreateCaseInput): Promise<EvalCase> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const created: EvalCase = {
      id,
      workspaceId: input.workspaceId,
      snapshotId: input.snapshotId,
      name: input.name,
      assertions: input.assertions,
      status: "pending",
      lastRunId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.cases.set(id, created);
    return created;
  }

  async findCase(workspaceId: string, id: string): Promise<EvalCase | null> {
    const found = this.cases.get(id);
    return found && found.workspaceId === workspaceId ? found : null;
  }

  async listCases(workspaceId: string): Promise<EvalCase[]> {
    return [...this.cases.values()].filter((c) => c.workspaceId === workspaceId);
  }

  async listCasesWithLatestRun(workspaceId: string): Promise<EvalCaseListItem[]> {
    return [...this.cases.values()]
      .filter((c) => c.workspaceId === workspaceId)
      .map((evalCase) => {
        const latest = this.runs
          .filter((r) => r.workspaceId === workspaceId && r.caseId === evalCase.id)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        // No agents table in-memory: resolve the captured agent straight off the
        // snapshot (full config first, then the legacy thin AgentSnapshot).
        const snapshot = this.snapshots.get(evalCase.snapshotId);
        const agentId = snapshot?.sourceAgentId ?? null;
        const name =
          snapshot?.originalAgentConfig?.name ?? snapshot?.originalAgent?.name ?? null;
        return {
          ...evalCase,
          latestRun: latest
            ? {
                id: latest.id,
                status: latest.status,
                mode: latest.mode,
                startedAt: latest.startedAt,
                completedAt: latest.completedAt,
                modelId: latest.resolvedConfig.modelId ?? null,
                outcomeReason: latest.outcomeReason,
              }
            : null,
          agent: { agentId, name, deleted: false },
        };
      });
  }

  async deleteCase(workspaceId: string, caseId: string): Promise<boolean> {
    const existing = this.cases.get(caseId);
    if (!existing || existing.workspaceId !== workspaceId) {
      return false;
    }
    this.cases.delete(caseId);
    this.runs.forEach((run, index) => {
      if (run.workspaceId === workspaceId && run.caseId === caseId) {
        this.runs[index] = { ...run, caseId: null };
      }
    });
    return true;
  }

  async updateCaseAssertions(
    workspaceId: string,
    caseId: string,
    assertions: EvalAssertion[],
  ): Promise<EvalCase> {
    const existing = this.requireCase(workspaceId, caseId);
    const updated: EvalCase = {
      ...existing,
      assertions,
      status: "pending",
      lastRunId: null,
      updatedAt: new Date().toISOString(),
    };
    this.cases.set(caseId, updated);
    return updated;
  }

  async updateCaseName(workspaceId: string, caseId: string, name: string): Promise<EvalCase> {
    const existing = this.requireCase(workspaceId, caseId);
    const updated: EvalCase = { ...existing, name, updatedAt: new Date().toISOString() };
    this.cases.set(caseId, updated);
    return updated;
  }

  async createRun(input: CreateRunInput): Promise<EvalRun> {
    const now = new Date().toISOString();
    const run: EvalRun = {
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      snapshotId: input.snapshotId,
      caseId: input.caseId,
      mode: input.mode,
      overrides: input.overrides,
      resolvedConfig: input.resolvedConfig,
      observedOutput: input.observedOutput,
      assertionVerdicts: input.assertionVerdicts,
      status: input.status,
      outcomeReason: input.outcomeReason,
      startedAt: now,
      completedAt: input.completedAt.toISOString(),
    };
    this.runs.push(run);
    return run;
  }

  async listRunsForCase(workspaceId: string, caseId: string): Promise<EvalRun[]> {
    return this.runs.filter((r) => r.workspaceId === workspaceId && r.caseId === caseId);
  }

  async updateCaseLastRun(
    workspaceId: string,
    caseId: string,
    lastRunId: string,
    status: EvalCaseStatus,
  ): Promise<EvalCase | null> {
    const existing = this.cases.get(caseId);
    if (!existing || existing.workspaceId !== workspaceId) {
      return null;
    }
    const updated: EvalCase = {
      ...existing,
      lastRunId,
      status,
      updatedAt: new Date().toISOString(),
    };
    this.cases.set(caseId, updated);
    return updated;
  }

  getRuns(): EvalRun[] {
    return [...this.runs];
  }

  private requireCase(workspaceId: string, caseId: string): EvalCase {
    const existing = this.cases.get(caseId);
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new Error(`Eval case ${caseId} not found in workspace ${workspaceId}`);
    }
    return existing;
  }
}

export const createInMemoryEvalRepository = (initial?: {
  snapshots?: EvalSnapshot[];
  cases?: EvalCase[];
}): InMemoryEvalRepository => new InMemoryEvalRepository(initial);
