import { randomUUID } from "node:crypto";

import { AppError, badRequest, notFound } from "../../../shared/domain/errors.js";
import type { AgentRevision } from "../../agents/public.js";
import { freezeTestValues, type ContextVariableTestValueCatalogPort, type ContextVariableTestValueSelection, type FrozenTestValue, type ResolvedVariableInput, type TestValue } from "../../context-variables/public.js";
import type { EvalCase, EvalRunMode, EvalSnapshot } from "../domain/types.js";
import type { FrozenRevisionEvalCaseResult } from "./evalRunService.js";

export type RevisionEvalState = "pending" | "running" | "partial" | "failed" | "completed";
export type RevisionEvalEvidenceState = "current" | "configuration_changed" | "environment_changed" | "comparability_unknown";
export type RevisionEvalOutcome = "pass" | "fail" | "partial" | "unavailable";

type RevisionEvalTestValue = TestValue;
export type FrozenRevisionEvalTestValue = FrozenTestValue;
export interface RevisionEvalCaseRecord {
  id: string; caseId: string; frozenCase: EvalCase; frozenSnapshot: EvalSnapshot;
  state: "pending" | "running" | "failed" | "completed"; outcome: RevisionEvalOutcome;
  result: FrozenRevisionEvalCaseResult | null; activeAttemptId: string | null; activeFence: number | null; leaseExpiresAt: Date | null;
}
export interface RevisionEvalSide { id: string; ordinal: number; revisionId: string; revision: AgentRevision; state: RevisionEvalState; cases: readonly RevisionEvalCaseRecord[]; }
export interface RevisionEvalRun { id: string; workspaceId: string; agentId: string; actorAccountId: string | null; mode: EvalRunMode; executionPolicy: "safe_test"; testValues: readonly FrozenRevisionEvalTestValue[]; state: RevisionEvalState; sides: readonly RevisionEvalSide[]; createdAt: Date; idempotencyKey: string; }

export interface RevisionEvalRepositoryPort {
  /** A repeated `idempotencyKey` for the same workspace/agent replays the run it already created instead of starting a second one. */
  create(input: RevisionEvalRun): Promise<RevisionEvalRun>;
  findByIdempotencyKey(input: { workspaceId: string; agentId: string; idempotencyKey: string }): Promise<RevisionEvalRun | null>;
  find(input: { workspaceId: string; runId: string }): Promise<RevisionEvalRun | null>;
  claimNext(input: { workspaceId: string; runId: string; now: Date; leaseMs: number; attemptId: string }): Promise<"none" | { run: RevisionEvalRun; side: RevisionEvalSide; evalCase: RevisionEvalCaseRecord; fence: number }>;
  complete(input: { workspaceId: string; runId: string; runCaseId: string; attemptId: string; fence: number; result: FrozenRevisionEvalCaseResult; now: Date }): Promise<boolean>;
  fail(input: { workspaceId: string; runId: string; runCaseId: string; attemptId: string; fence: number; result: FrozenRevisionEvalCaseResult; now: Date }): Promise<boolean>;
  retryFailed(input: { workspaceId: string; runId: string; revisionId: string; caseId: string }): Promise<boolean>;
}
interface RevisionEvalRevisionReaderPort {
  /** Resolves ownership from an immutable revision ID; HTTP never supplies agentId. */
  findRevisionByWorkspace(input: { workspaceId: string; revisionId: string }): Promise<{ agentId: string; revision: AgentRevision } | null>;
  findRevision(input: { workspaceId: string; agentId: string; revisionId: string }): Promise<AgentRevision | null>;
}
interface RevisionEvalCaseReaderPort { findCase(workspaceId: string, id: string): Promise<EvalCase | null>; findSnapshot(workspaceId: string, id: string): Promise<EvalSnapshot | null>; }
interface RevisionEvalRunnerPort { executeFrozenRevisionCase(input: { workspaceId: string; accountId: string | null; agentId: string; revision: AgentRevision; snapshot: EvalSnapshot; assertions: EvalCase["assertions"]; mode: EvalRunMode; testValues: readonly ResolvedVariableInput[]; executionPolicy: "safe_test"; correlationId: string }): Promise<FrozenRevisionEvalCaseResult>; }
/** Mirrors TestExecutionAuditPort: both durable-evidence surfaces that dispatch paid provider calls audit the same narrow shape. */
interface RevisionEvalRunAuditPort {
  record(input: { workspaceId: string; accountId: string | null; eventType: string; eventStatus: "success" | "failure"; metadata: Record<string, string | number | boolean | null> }): Promise<void>;
}

export class RevisionEvalRunService {
  private readonly now: () => Date;
  private readonly leaseMs: number;
  constructor(private readonly options: { repository: RevisionEvalRepositoryPort; revisions: RevisionEvalRevisionReaderPort; cases: RevisionEvalCaseReaderPort; contextCatalog: ContextVariableTestValueCatalogPort; runner: RevisionEvalRunnerPort; audit?: RevisionEvalRunAuditPort; logger?: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void }; now?: () => Date; leaseMs?: number }) { this.now = options.now ?? (() => new Date()); this.leaseMs = options.leaseMs ?? 60_000; }

  async start(input: { workspaceId: string; accountId: string | null; revisionIds: readonly string[]; caseIds: readonly string[]; testValues: readonly RevisionEvalTestValue[]; mode: EvalRunMode; executionPolicy: "safe_test"; idempotencyKey: string }): Promise<RevisionEvalRun> {
    if (input.executionPolicy !== "safe_test") throw badRequest("Revision evaluations require safe_test execution policy.");
    if (input.revisionIds.length < 1 || input.revisionIds.length > 2 || new Set(input.revisionIds).size !== input.revisionIds.length) throw badRequest("Revision evaluation requires one or two distinct immutable revisions.");
    if (input.caseIds.length < 1 || new Set(input.caseIds).size !== input.caseIds.length) throw badRequest("Revision evaluation requires distinct eval cases.");
    const owner = await this.options.revisions.findRevisionByWorkspace({ workspaceId: input.workspaceId, revisionId: input.revisionIds[0] });
    if (!owner) throw notFound("Agent revision is unavailable.");
    const agentId = owner.agentId;
    // A retried or double-clicked start must replay the run it already created, checked as soon
    // as the owning agent is known and before any case lookup or background dispatch.
    const replay = await this.options.repository.findByIdempotencyKey({ workspaceId: input.workspaceId, agentId, idempotencyKey: input.idempotencyKey });
    if (replay) return replay;
    const revisions = await Promise.all(input.revisionIds.map(async (revisionId, index) => {
      if (index === 0) return owner.revision;
      const revision = await this.options.revisions.findRevision({ workspaceId: input.workspaceId, agentId, revisionId });
      if (!revision) throw notFound("Agent revision is unavailable.");
      return revision;
    }));
    const cases = await Promise.all(input.caseIds.map(async (caseId) => {
      const evalCase = await this.options.cases.findCase(input.workspaceId, caseId);
      if (!evalCase) throw notFound("Eval case is unavailable.");
      const snapshot = await this.options.cases.findSnapshot(input.workspaceId, evalCase.snapshotId);
      // Do not reveal whether a case exists outside the selected agent/workspace scope.
      if (!snapshot || snapshot.sourceAgentId !== agentId) throw notFound("Eval case is unavailable.");
      return { evalCase, snapshot };
    }));
    const values = await freezeTestValues({
      workspaceId: input.workspaceId,
      catalog: this.options.contextCatalog,
      selectedEnablements: revisions.map((revision): readonly ContextVariableTestValueSelection[] => revision.snapshot.contextVariableEnablements.map(({ variableId, enabled }) => ({ variableId, enabled }))),
      supplied: input.testValues,
    });
    const id = randomUUID();
    const run: RevisionEvalRun = { id, workspaceId: input.workspaceId, agentId, actorAccountId: input.accountId, mode: input.mode, executionPolicy: "safe_test", testValues: values, state: "pending", createdAt: this.now(), idempotencyKey: input.idempotencyKey, sides: revisions.map((revision, ordinal) => ({ id: randomUUID(), ordinal, revisionId: revision.id, revision, state: "pending", cases: cases.map(({ evalCase, snapshot }) => ({ id: randomUUID(), caseId: evalCase.id, frozenCase: structuredClone(evalCase), frozenSnapshot: structuredClone(snapshot), state: "pending", outcome: "unavailable", result: null, activeAttemptId: null, activeFence: null, leaseExpiresAt: null })) })) };
    const created = await this.options.repository.create(run);
    this.options.logger?.info({ workspaceId: input.workspaceId, agentId, revisionEvalRunId: id, sideCount: created.sides.length, caseCount: input.caseIds.length }, "Revision eval run created");
    await this.audit(input, "agent.revision_eval_run.started", "success", { revisionEvalRunId: id, agentId, mode: input.mode, sideCount: created.sides.length, caseCount: input.caseIds.length });
    this.dispatch({ workspaceId: input.workspaceId, runId: id, accountId: input.accountId });
    return created;
  }

  async get(input: { workspaceId: string; runId: string; accountId: string | null }): Promise<RevisionEvalRun> {
    const run = await this.options.repository.find(input);
    if (!run) throw notFound("Revision eval run is unavailable.");
    // Recovery uses the persisted originating actor; the polling identity never changes quota/audit attribution.
    if (run.state === "pending" || run.state === "running") this.dispatch({ workspaceId: input.workspaceId, runId: input.runId, accountId: run.actorAccountId });
    return run;
  }

  currentCase(workspaceId: string, caseId: string): Promise<EvalCase | null> { return this.options.cases.findCase(workspaceId, caseId); }

  /** Reads the immutable revision row to enrich old frozen evidence with its release number. */
  revisionSummary(workspaceId: string, agentId: string, revisionId: string): Promise<AgentRevision | null> {
    return this.options.revisions.findRevision({ workspaceId, agentId, revisionId });
  }

  async resume(input: { workspaceId: string; runId: string; accountId: string | null }): Promise<void> {
    for (;;) {
      const attemptId = randomUUID();
      const claim = await this.options.repository.claimNext({ workspaceId: input.workspaceId, runId: input.runId, now: this.now(), leaseMs: this.leaseMs, attemptId });
      if (claim === "none") {
        await this.auditCompletionIfSettled(input);
        return;
      }
      try {
        const variables = variablesForRevision(claim.run.testValues, claim.side.revision);
        const result = await this.options.runner.executeFrozenRevisionCase({ workspaceId: input.workspaceId, accountId: claim.run.actorAccountId, agentId: claim.run.agentId, revision: claim.side.revision, snapshot: claim.evalCase.frozenSnapshot, assertions: claim.evalCase.frozenCase.assertions, mode: claim.run.mode, testValues: variables, executionPolicy: "safe_test", correlationId: attemptId });
        if (result.status === "error") {
          await this.options.repository.fail({ workspaceId: input.workspaceId, runId: input.runId, runCaseId: claim.evalCase.id, attemptId, fence: claim.fence, result, now: this.now() });
        } else {
          await this.options.repository.complete({ workspaceId: input.workspaceId, runId: input.runId, runCaseId: claim.evalCase.id, attemptId, fence: claim.fence, result, now: this.now() });
        }
      } catch (error) {
        // A config/wiring error (e.g. missing live agent config or runner) never reached a
        // provider, so it keeps its own distinguishable reason instead of reporting as a
        // generic runner failure — the same broad catch still absorbs genuine provider errors.
        const configError = error instanceof AppError;
        const failureCode = configError ? error.code : "runner_failed";
        const result: FrozenRevisionEvalCaseResult = { status: "error", outcomeReason: failureCode, assertionVerdicts: [], observedOutput: { retrievedChunks: [], error: { message: configError ? error.message : "revision_eval_runner_failed", code: failureCode } }, resolvedConfig: {} };
        try { await this.options.repository.fail({ workspaceId: input.workspaceId, runId: input.runId, runCaseId: claim.evalCase.id, attemptId, fence: claim.fence, result, now: this.now() }); } catch { this.options.logger?.warn({ workspaceId: input.workspaceId, revisionEvalRunId: input.runId, revisionEvalCaseId: claim.evalCase.id }, "Revision eval failure persistence failed"); return; }
        this.options.logger?.warn({ workspaceId: input.workspaceId, revisionEvalRunId: input.runId, revisionEvalCaseId: claim.evalCase.id }, "Revision eval case failed");
      }
    }
  }

  async retry(input: { workspaceId: string; runId: string; revisionId: string; caseId: string; accountId: string | null }): Promise<RevisionEvalRun> {
    if (!await this.options.repository.retryFailed(input)) throw notFound("Failed revision eval case is unavailable.");
    this.dispatch(input);
    const run = await this.options.repository.find(input);
    if (!run) throw notFound("Revision eval run is unavailable.");
    return run;
  }

  private dispatch(input: { workspaceId: string; runId: string; accountId: string | null }): void {
    void this.resume(input).catch(() => this.options.logger?.warn({ workspaceId: input.workspaceId, revisionEvalRunId: input.runId }, "Revision eval dispatch failed"));
  }

  /**
   * Fired once resume's claim loop finds nothing left to do. Multiple dispatches can poll the
   * same run concurrently (every start/get/retry dispatches), so this can occasionally fire
   * more than once for one settle; it is evidence of completion, not an exactly-once ledger.
   */
  private async auditCompletionIfSettled(input: { workspaceId: string; runId: string; accountId: string | null }): Promise<void> {
    const run = await this.options.repository.find(input);
    if (!run || run.state === "pending" || run.state === "running") return;
    const eventType = run.state === "completed" ? "agent.revision_eval_run.completed" : "agent.revision_eval_run.partial";
    await this.audit(input, eventType, run.state === "completed" ? "success" : "failure", { revisionEvalRunId: run.id, agentId: run.agentId, state: run.state, sideCount: run.sides.length });
  }

  private async audit(input: { workspaceId: string; accountId: string | null }, eventType: string, eventStatus: "success" | "failure", metadata: Record<string, string | number | boolean | null>): Promise<void> {
    try { await this.options.audit?.record({ workspaceId: input.workspaceId, accountId: input.accountId, eventType, eventStatus, metadata }); }
    catch { this.options.logger?.warn({ workspaceId: input.workspaceId, revisionEvalRunId: metadata.revisionEvalRunId, eventType }, "Revision eval run audit recording failed"); }
  }
}

const variablesForRevision = (values: readonly FrozenRevisionEvalTestValue[], revision: AgentRevision): ResolvedVariableInput[] => values.map((value) => {
  const enablement = revision.snapshot.contextVariableEnablements.find((item) => item.variableId === value.contextVariableId && item.enabled);
  if (!enablement) throw new Error("frozen_revision_eval_sample_not_enabled");
  return { name: value.name, description: value.description, value: value.value, surfacing: enablement.surfacing, sensitive: value.sensitive, trust: value.trust };
});
