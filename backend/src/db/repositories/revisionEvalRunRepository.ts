import { parseAgentRevisionSnapshot, type AgentRevision } from "../../modules/agents/public.js";
import type { EvalCase, EvalSnapshot } from "../../modules/eval/domain/types.js";
import type { FrozenRevisionEvalCaseResult } from "../../modules/eval/services/evalRunService.js";
import type { RevisionEvalCaseRecord, RevisionEvalRepositoryPort, RevisionEvalRun, RevisionEvalSide, RevisionEvalState } from "../../modules/eval/services/revisionEvalRun.js";
import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * A run executes one provider case at a time. The run-row lock serializes this
 * database-backed limit across HTTP pollers and application instances; execution
 * itself remains outside the transaction and expired leases are fenced on reclaim.
 */
const maxLiveRevisionEvalCaseClaimsPerRun = 1;

const revision = (row: { revision_id: string; frozen_revision: unknown }): AgentRevision => {
  const value = row.frozen_revision as Omit<AgentRevision, "createdAt" | "publishedAt" | "publishedVersion"> & { createdAt: string | Date; publishedAt: string | Date | null; publishedVersion?: number | null };
  if (value.id !== row.revision_id) throw new Error("revision_eval_frozen_revision_identity_mismatch");
  return { ...value, id: row.revision_id, snapshot: parseAgentRevisionSnapshot(value.snapshot), createdAt: new Date(value.createdAt), publishedAt: value.publishedAt ? new Date(value.publishedAt) : null, publishedVersion: value.publishedVersion ?? null };
};
const asCase = (value: unknown): EvalCase => value as EvalCase;
const asSnapshot = (value: unknown): EvalSnapshot => value as EvalSnapshot;
const asResult = (row: { assertion_verdicts: unknown; observed_output: unknown; resolved_config: unknown; outcome_reason: string | null; outcome: string }): FrozenRevisionEvalCaseResult | null => row.assertion_verdicts && row.observed_output && row.resolved_config ? { status: row.outcome === "pass" ? "pass" : row.outcome === "fail" ? "fail" : "error", outcomeReason: row.outcome_reason, assertionVerdicts: row.assertion_verdicts as FrozenRevisionEvalCaseResult["assertionVerdicts"], observedOutput: row.observed_output as FrozenRevisionEvalCaseResult["observedOutput"], resolvedConfig: row.resolved_config } : null;
const aggregate = (states: readonly string[]): RevisionEvalState => {
  if (states.some((state) => state === "pending" || state === "running")) return "running";
  if (states.every((state) => state === "completed")) return "completed";
  if (states.some((state) => state === "partial")) return "partial";
  return states.some((state) => state === "completed") ? "partial" : "failed";
};

export class RevisionEvalRunRepository implements RevisionEvalRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: RevisionEvalRun): Promise<RevisionEvalRun> {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto("revision_eval_runs").values({ id: input.id, workspace_id: input.workspaceId, agent_id: input.agentId, actor_account_id: input.actorAccountId, mode: input.mode, execution_policy: input.executionPolicy, test_values: toJsonb(input.testValues), state: input.state }).execute();
      for (const side of input.sides) {
        await trx.insertInto("revision_eval_run_sides").values({ id: side.id, run_id: input.id, revision_id: side.revisionId, side_ordinal: side.ordinal, frozen_revision: toJsonb({ ...side.revision, createdAt: side.revision.createdAt.toISOString(), publishedAt: side.revision.publishedAt?.toISOString() ?? null }), state: side.state }).execute();
        for (const item of side.cases) await trx.insertInto("revision_eval_run_cases").values({ id: item.id, side_id: side.id, case_id: item.caseId, frozen_case: toJsonb(item.frozenCase), frozen_snapshot: toJsonb(item.frozenSnapshot), state: item.state, outcome: item.outcome, assertion_verdicts: null, observed_output: null, resolved_config: null, outcome_reason: null, active_attempt_id: null, active_fence: null, lease_expires_at: null, completed_at: null }).execute();
      }
    });
    const result = await this.find({ workspaceId: input.workspaceId, runId: input.id });
    if (!result) throw new Error("revision_eval_run_create_lost");
    return result;
  }

  async find(input: { workspaceId: string; runId: string }): Promise<RevisionEvalRun | null> {
    const run = await this.db.selectFrom("revision_eval_runs").selectAll().where("id", "=", input.runId).where("workspace_id", "=", input.workspaceId).executeTakeFirst();
    if (!run) return null;
    const sideRows = await this.db.selectFrom("revision_eval_run_sides").selectAll().where("run_id", "=", run.id).orderBy("side_ordinal").execute();
    const caseRows = await this.db.selectFrom("revision_eval_run_cases").selectAll().where("side_id", "in", sideRows.map((side) => side.id).length ? sideRows.map((side) => side.id) : ["00000000-0000-0000-0000-000000000000"]).orderBy("id").execute();
    const sides: RevisionEvalSide[] = sideRows.map((side) => {
      const cases = caseRows.filter((item) => item.side_id === side.id).map((item): RevisionEvalCaseRecord => ({ id: item.id, caseId: item.case_id, frozenCase: asCase(item.frozen_case), frozenSnapshot: asSnapshot(item.frozen_snapshot), state: item.state as RevisionEvalCaseRecord["state"], outcome: item.outcome as RevisionEvalCaseRecord["outcome"], result: asResult(item), activeAttemptId: item.active_attempt_id, activeFence: item.active_fence, leaseExpiresAt: item.lease_expires_at, }));
      return { id: side.id, ordinal: side.side_ordinal, revisionId: side.revision_id, revision: revision(side), state: aggregate(cases.map((item) => item.state)), cases };
    });
    return { id: run.id, workspaceId: run.workspace_id, agentId: run.agent_id, actorAccountId: run.actor_account_id, mode: run.mode as RevisionEvalRun["mode"], executionPolicy: "safe_test", testValues: run.test_values as unknown as RevisionEvalRun["testValues"], state: aggregate(sides.map((side) => side.state)), sides, createdAt: new Date(run.created_at) };
  }

  async claimNext(input: { workspaceId: string; runId: string; now: Date; leaseMs: number; attemptId: string }): Promise<"none" | { run: RevisionEvalRun; side: RevisionEvalSide; evalCase: RevisionEvalCaseRecord; fence: number }> {
    const claimed = await this.db.transaction().execute(async (trx) => {
      const run = await trx.selectFrom("revision_eval_runs").selectAll().where("id", "=", input.runId).where("workspace_id", "=", input.workspaceId).forUpdate().executeTakeFirst();
      if (!run) return null;
      const liveClaimCount = await trx.selectFrom("revision_eval_run_cases as c").innerJoin("revision_eval_run_sides as s", "s.id", "c.side_id").select((eb) => eb.fn.countAll<number>().as("count")).where("s.run_id", "=", input.runId).where("c.state", "=", "running").where("c.lease_expires_at", ">=", input.now).executeTakeFirstOrThrow();
      if (Number(liveClaimCount.count) >= maxLiveRevisionEvalCaseClaimsPerRun) return null;
      const item = await trx.selectFrom("revision_eval_run_cases as c").innerJoin("revision_eval_run_sides as s", "s.id", "c.side_id").select(["c.id as case_row_id", "c.state as case_state", "c.active_fence", "c.lease_expires_at", "s.id as side_id"]).where("s.run_id", "=", input.runId).where((eb) => eb.or([eb("c.state", "=", "pending"), eb.and([eb("c.state", "=", "running"), eb("c.lease_expires_at", "<", input.now)])])).orderBy("c.created_at").forUpdate().executeTakeFirst();
      if (!item) return null;
      const latestAttempt = await trx.selectFrom("revision_eval_run_attempts").select("fence").where("run_case_id", "=", item.case_row_id).orderBy("fence", "desc").forUpdate().executeTakeFirst();
      const fence = (latestAttempt?.fence ?? 0) + 1;
      const expires = new Date(input.now.getTime() + input.leaseMs);
      if (item.case_state === "running") await trx.updateTable("revision_eval_run_attempts").set({ state: "failed", failure_code: "lease_expired", updated_at: currentTimestamp() }).where("run_case_id", "=", item.case_row_id).where("fence", "=", item.active_fence!).execute();
      await trx.insertInto("revision_eval_run_attempts").values({ id: input.attemptId, run_case_id: item.case_row_id, fence, state: "running", lease_expires_at: expires, failure_code: null }).execute();
      await trx.updateTable("revision_eval_run_cases").set({ state: "running", outcome: "unavailable", active_attempt_id: input.attemptId, active_fence: fence, lease_expires_at: expires, updated_at: currentTimestamp() }).where("id", "=", item.case_row_id).execute();
      await trx.updateTable("revision_eval_run_sides").set({ state: "running", updated_at: currentTimestamp() }).where("id", "=", item.side_id).execute();
      await trx.updateTable("revision_eval_runs").set({ state: "running", updated_at: currentTimestamp() }).where("id", "=", input.runId).execute();
      return item.case_row_id;
    });
    if (!claimed) return "none";
    const run = await this.find({ workspaceId: input.workspaceId, runId: input.runId });
    if (!run) return "none";
    for (const side of run.sides) { const evalCase = side.cases.find((item) => item.id === claimed); if (evalCase) return { run, side, evalCase, fence: evalCase.activeFence! }; }
    return "none";
  }

  async complete(input: { workspaceId: string; runId: string; runCaseId: string; attemptId: string; fence: number; result: FrozenRevisionEvalCaseResult; now: Date }): Promise<boolean> { return this.finish(input, "completed"); }
  async fail(input: { workspaceId: string; runId: string; runCaseId: string; attemptId: string; fence: number; result: FrozenRevisionEvalCaseResult; now: Date }): Promise<boolean> { return this.finish(input, "failed"); }
  async retryFailed(input: { workspaceId: string; runId: string; revisionId: string; caseId: string }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("revision_eval_run_cases as c").innerJoin("revision_eval_run_sides as s", "s.id", "c.side_id").innerJoin("revision_eval_runs as r", "r.id", "s.run_id").select("c.id").where("r.workspace_id", "=", input.workspaceId).where("s.run_id", "=", input.runId).where("s.revision_id", "=", input.revisionId).where("c.case_id", "=", input.caseId).where("c.state", "=", "failed").forUpdate().executeTakeFirst();
      if (!row) return false;
      await trx.updateTable("revision_eval_run_cases").set({ state: "pending", outcome: "unavailable", outcome_reason: null, active_attempt_id: null, active_fence: null, lease_expires_at: null, updated_at: currentTimestamp() }).where("id", "=", row.id).execute();
      await trx.updateTable("revision_eval_runs").set({ state: "pending", updated_at: currentTimestamp() }).where("id", "=", input.runId).execute();
      return true;
    });
  }
  private async finish(input: { workspaceId: string; runId: string; runCaseId: string; attemptId: string; fence: number; now: Date; result?: FrozenRevisionEvalCaseResult }, terminal: "completed" | "failed"): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("revision_eval_run_cases as c").innerJoin("revision_eval_run_sides as s", "s.id", "c.side_id").innerJoin("revision_eval_runs as r", "r.id", "s.run_id").select(["c.id as id"]).where("c.id", "=", input.runCaseId).where("s.run_id", "=", input.runId).where("r.workspace_id", "=", input.workspaceId).where("c.active_attempt_id", "=", input.attemptId).where("c.active_fence", "=", input.fence).forUpdate().executeTakeFirst();
      if (!row) return false;
      const result = input.result;
      const outcome = terminal === "failed" ? "partial" : result!.status === "pass" ? "pass" : result!.status === "fail" ? "fail" : "partial";
      await trx.updateTable("revision_eval_run_attempts").set({ state: terminal, failure_code: terminal === "failed" ? "runner_failed" : null, updated_at: currentTimestamp() }).where("id", "=", input.attemptId).where("run_case_id", "=", input.runCaseId).where("fence", "=", input.fence).execute();
      await trx.updateTable("revision_eval_run_cases").set({ state: terminal, outcome, assertion_verdicts: result ? toJsonb(result.assertionVerdicts) : null, observed_output: result ? toJsonb(result.observedOutput) : null, resolved_config: result ? toJsonb(result.resolvedConfig) : null, outcome_reason: result?.outcomeReason ?? (terminal === "failed" ? "runner_failed" : null), active_attempt_id: null, active_fence: null, lease_expires_at: null, completed_at: currentTimestamp(), updated_at: currentTimestamp() }).where("id", "=", input.runCaseId).execute();
      const all = await trx.selectFrom("revision_eval_run_cases as c").innerJoin("revision_eval_run_sides as s", "s.id", "c.side_id").select("c.state").where("s.run_id", "=", input.runId).execute();
      const next = aggregate(all.map((item) => item.state));
      await trx.updateTable("revision_eval_runs").set({ state: next, updated_at: currentTimestamp() }).where("id", "=", input.runId).execute();
      return true;
    });
  }
}
