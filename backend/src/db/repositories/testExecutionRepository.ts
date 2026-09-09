import type { AgentRevision } from "../../modules/agents/agentRevision.js";
import type { Transaction } from "kysely";
import { parseAgentRevisionSnapshot } from "../../modules/agents/agentRevision.js";
import type { TestExecution, TestExecutionAttempt, TestExecutionAttemptRecord, TestExecutionClaim, TestExecutionHistoryItem, TestExecutionHistorySide, TestExecutionRepositoryPort, TestExecutionRunnerResult, TestExecutionSide, TestExecutionState } from "../../modules/test-execution/testExecution.js";
import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";
import { decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";

type ClaimInput = Parameters<TestExecutionRepositoryPort["claimTurn"]>[0];
type CompleteInput = Parameters<TestExecutionRepositoryPort["complete"]>[0];
type FailInput = Parameters<TestExecutionRepositoryPort["fail"]>[0];
type TransactionDb = Transaction<DB>;

const mapRevision = (row: { id: string; snapshot: unknown; source_draft_generation: number; source_base_published_revision_id: string | null; created_at: Date; published_at: Date | null; published_version: number | null }): AgentRevision => ({
  id: row.id, snapshot: parseAgentRevisionSnapshot(row.snapshot), sourceDraftGeneration: row.source_draft_generation,
  sourceBasePublishedRevisionId: row.source_base_published_revision_id, createdAt: new Date(row.created_at), publishedAt: row.published_at ? new Date(row.published_at) : null, publishedVersion: row.published_version,
});
const parseHistory = (value: unknown): TestExecutionSide["history"] => Array.isArray(value) ? value.map((entry) => {
  const item = entry as Omit<TestExecutionSide["history"][number], "createdAt"> & { createdAt: Date | string };
  return { ...item, createdAt: new Date(item.createdAt) };
}) : [];
const parseResult = (value: unknown): TestExecutionRunnerResult | undefined => value && typeof value === "object" ? value as TestExecutionRunnerResult : undefined;
const appendUser = (history: TestExecutionSide["history"], input: ClaimInput) => history.some((entry) => entry.role === "user" && entry.turnId === input.turnId) ? history : [...history, { turnId: input.turnId, attemptId: input.attemptId, role: "user" as const, content: input.message, createdAt: input.now }];
const appendAssistant = (history: TestExecutionSide["history"], input: CompleteInput) => [...history, { turnId: input.turnId, attemptId: input.attemptId, role: "assistant" as const, content: input.result.answer, messageId: input.result.messageId, createdAt: input.now }];

/** Postgres system of record for private test execution state and side-level fencing. */
export class TestExecutionRepository implements TestExecutionRepositoryPort {
  constructor(private readonly db: Db) {}

  async findRevision(input: { workspaceId: string; agentId: string; revisionId: string }): Promise<AgentRevision | null> {
    const row = await this.db.selectFrom("agent_revisions").selectAll().where("workspace_id", "=", input.workspaceId).where("agent_id", "=", input.agentId).where("id", "=", input.revisionId).executeTakeFirst();
    return row ? mapRevision(row) : null;
  }

  async readDraftGeneration(input: { workspaceId: string; agentId: string }): Promise<number | null> {
    const row = await this.db.selectFrom("agent_drafts").select("generation").where("workspace_id", "=", input.workspaceId).where("agent_id", "=", input.agentId).executeTakeFirst();
    return row?.generation ?? null;
  }

  async create(input: Parameters<TestExecutionRepositoryPort["create"]>[0]): Promise<TestExecution> {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto("agent_test_executions").values({ id: input.id, workspace_id: input.workspaceId, agent_id: input.agentId, mode: input.mode, generation: input.generation, state: input.state ?? "running", test_values: toJsonb(input.testValues) }).execute();
      for (const [sideOrdinal, side] of input.sides.entries()) await trx.insertInto("agent_test_execution_sides").values({ id: side.id, execution_id: input.id, workspace_id: input.workspaceId, agent_id: input.agentId, revision_id: side.revision.id, conversation_id: side.conversationId, state: side.state, retryable: side.retryable, history: toJsonb(side.history), continuation: side.continuation === null ? null : toJsonb(side.continuation), active_turn_id: null, active_attempt_id: null, active_fence: null, side_ordinal: sideOrdinal }).execute();
    });
    const created = await this.find({ workspaceId: input.workspaceId, agentId: input.agentId, executionId: input.id });
    if (!created) throw new Error("test_execution_create_lost");
    return created;
  }

  async find(input: { workspaceId: string; agentId: string; executionId: string }): Promise<TestExecution | null> {
    const execution = await this.db.selectFrom("agent_test_executions").selectAll().where("id", "=", input.executionId).where("workspace_id", "=", input.workspaceId).where("agent_id", "=", input.agentId).executeTakeFirst();
    if (!execution) return null;
    const sides = await this.db.selectFrom("agent_test_execution_sides as s").innerJoin("agent_revisions as r", "r.id", "s.revision_id").select(["s.id as side_id", "s.execution_id as execution_id", "s.conversation_id as conversation_id", "s.state as side_state", "s.retryable as retryable", "s.history as history", "s.continuation as continuation", "r.id as id", "r.snapshot as snapshot", "r.source_draft_generation as source_draft_generation", "r.source_base_published_revision_id as source_base_published_revision_id", "r.created_at as created_at", "r.published_at as published_at", "r.published_version as published_version"]).where("s.execution_id", "=", execution.id).where("s.workspace_id", "=", input.workspaceId).where("s.agent_id", "=", input.agentId).orderBy("s.side_ordinal").execute();
    return { id: execution.id, workspaceId: execution.workspace_id, agentId: execution.agent_id, mode: execution.mode as TestExecution["mode"], generation: execution.generation, state: execution.state as TestExecutionState, testValues: execution.test_values as unknown as TestExecution["testValues"], createdAt: new Date(execution.created_at), sides: sides.map((side) => ({ id: side.side_id, executionId: side.execution_id, revision: mapRevision(side), conversationId: side.conversation_id, state: side.side_state as TestExecutionSide["state"], retryable: side.retryable, history: parseHistory(side.history), continuation: side.continuation })) };
  }

  async retainSide(input: Parameters<TestExecutionRepositoryPort["retainSide"]>[0]): Promise<Awaited<ReturnType<TestExecutionRepositoryPort["retainSide"]>>> {
    const retained = await this.db.transaction().execute(async (trx) => {
      const source = await trx.selectFrom("agent_test_executions").selectAll()
        .where("id", "=", input.executionId).where("workspace_id", "=", input.workspaceId).where("agent_id", "=", input.agentId)
        .forUpdate().executeTakeFirst();
      if (!source) return "not_found" as const;
      if (source.mode !== "compare") return "not_comparison" as const;
      const side = await trx.selectFrom("agent_test_execution_sides").selectAll()
        .where("id", "=", input.sideId).where("execution_id", "=", input.executionId).where("workspace_id", "=", input.workspaceId).where("agent_id", "=", input.agentId)
        .forUpdate().executeTakeFirst();
      if (!side) return "not_found" as const;
      if (side.active_attempt_id !== null || side.state === "failed") return "unsettled" as const;
      const state: TestExecutionState = side.state === "completed" ? "completed" : "running";
      await trx.insertInto("agent_test_executions").values({
        id: input.retainedExecutionId, workspace_id: input.workspaceId, agent_id: input.agentId,
        mode: "single", generation: 1, state, test_values: toJsonb(source.test_values),
      }).execute();
      await trx.insertInto("agent_test_execution_sides").values({
        id: input.retainedSideId, execution_id: input.retainedExecutionId, workspace_id: input.workspaceId, agent_id: input.agentId,
        revision_id: side.revision_id, conversation_id: input.retainedConversationId, state: side.state, retryable: side.retryable,
        history: toJsonb(side.history), continuation: side.continuation === null ? null : toJsonb(side.continuation), active_turn_id: null, active_attempt_id: null, active_fence: null, side_ordinal: 0,
      }).execute();
      return "retained" as const;
    });
    if (retained !== "retained") return retained;
    return (await this.find({ workspaceId: input.workspaceId, agentId: input.agentId, executionId: input.retainedExecutionId })) ?? "not_found";
  }

  async list(input: { workspaceId: string; agentId: string; limit: number; cursor?: string }): Promise<{ executions: readonly TestExecutionHistoryItem[]; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const rows = await this.db.selectFrom("agent_test_executions")
      .select(["id", "created_at", "mode", "generation", "state"])
      .where("workspace_id", "=", input.workspaceId)
      .where("agent_id", "=", input.agentId)
      .$if(Boolean(cursor), (qb) => qb.where((eb) => eb.or([
        eb("created_at", "<", new Date(cursor!.keys.createdAt)),
        eb.and([eb("created_at", "=", new Date(cursor!.keys.createdAt)), eb("id", "<", cursor!.keys.id)]),
      ])))
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(input.limit + 1)
      .execute();
    const pageRows = rows.slice(0, input.limit);
    const executionIds = pageRows.map((row) => row.id);
    const sideRows = executionIds.length === 0 ? [] : await this.db.selectFrom("agent_test_execution_sides as side")
      .innerJoin("agent_revisions as revision", "revision.id", "side.revision_id")
      .select(["side.id as side_id", "side.execution_id as execution_id", "side.conversation_id as conversation_id", "side.state as side_state", "side.retryable", "revision.id as revision_id", "revision.created_at as revision_created_at", "revision.published_at as revision_published_at", "revision.published_version as revision_published_version"])
      .where("side.workspace_id", "=", input.workspaceId)
      .where("side.agent_id", "=", input.agentId)
      .where("side.execution_id", "in", executionIds)
      .orderBy("side.execution_id")
      .orderBy("side.side_ordinal")
      .execute();
    const sidesByExecution = new Map<string, TestExecutionHistorySide[]>();
    for (const side of sideRows) {
      const prior = sidesByExecution.get(side.execution_id) ?? [];
      prior.push({ id: side.side_id, conversationId: side.conversation_id, state: side.side_state as TestExecutionSide["state"], retryable: side.retryable, revision: { id: side.revision_id, createdAt: new Date(side.revision_created_at), publishedAt: side.revision_published_at ? new Date(side.revision_published_at) : null, publishedVersion: side.revision_published_version } });
      sidesByExecution.set(side.execution_id, prior);
    }
    const executions = pageRows.map((row) => ({ id: row.id, mode: row.mode as TestExecution["mode"], generation: row.generation, state: row.state as TestExecutionState, createdAt: new Date(row.created_at), sides: sidesByExecution.get(row.id) ?? [] }));
    const last = pageRows.at(-1);
    return {
      executions,
      hasMore: rows.length > input.limit,
      nextCursor: rows.length > input.limit && last ? encodeCursor({ createdAt: new Date(last.created_at).toISOString(), id: last.id }) : null,
    };
  }

  async listAttempts(input: { workspaceId: string; agentId: string; executionId: string }): Promise<readonly TestExecutionAttemptRecord[]> {
    const rows = await this.db.selectFrom("agent_test_execution_attempts as attempt")
      .innerJoin("agent_test_executions as execution", "execution.id", "attempt.execution_id")
      .select(["attempt.execution_id", "attempt.side_id", "attempt.turn_id", "attempt.attempt_id", "attempt.fence", "attempt.state", "attempt.failure_code", "attempt.lease_expires_at", "attempt.created_at", "attempt.updated_at"])
      .where("execution.id", "=", input.executionId)
      .where("execution.workspace_id", "=", input.workspaceId)
      .where("execution.agent_id", "=", input.agentId)
      .orderBy("attempt.created_at")
      .orderBy("attempt.side_id")
      .orderBy("attempt.fence")
      .execute();
    return rows.map((row) => ({
      executionId: row.execution_id,
      sideId: row.side_id,
      turnId: row.turn_id,
      attemptId: row.attempt_id,
      fence: row.fence,
      state: row.state as TestExecutionAttemptRecord["state"],
      failureCode: row.failure_code,
      leaseExpiresAt: new Date(row.lease_expires_at),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  }

  async claimTurn(input: ClaimInput): Promise<Awaited<ReturnType<TestExecutionRepositoryPort["claimTurn"]>>> {
    return this.db.transaction().execute(async (trx) => {
      const execution = await trx.selectFrom("agent_test_executions").selectAll().where("id", "=", input.executionId).where("workspace_id", "=", input.workspaceId).where("agent_id", "=", input.agentId).forUpdate().executeTakeFirst();
      if (!execution || execution.generation !== input.generation) return "generation_conflict";
      const sideIds = [...new Set(input.sideIds)].sort();
      const sides = await trx.selectFrom("agent_test_execution_sides").selectAll().where("execution_id", "=", input.executionId).where("workspace_id", "=", input.workspaceId).where("agent_id", "=", input.agentId).where("id", "in", sideIds).orderBy("id").forUpdate().execute();
      if (sides.length !== sideIds.length) return "turn_conflict";
      const turn = await trx.selectFrom("agent_test_execution_turns").selectAll().where("execution_id", "=", input.executionId).where("turn_id", "=", input.turnId).forUpdate().executeTakeFirst();
      if (!turn) {
        if (input.retry) return "retry_invalid";
        const unresolved = await trx.selectFrom("agent_test_execution_turns").select("turn_id").where("execution_id", "=", input.executionId).where("state", "!=", "completed").executeTakeFirst();
        if (unresolved || sides.some((side) => side.active_attempt_id !== null)) return "turn_conflict";
        await trx.insertInto("agent_test_execution_turns").values({ execution_id: input.executionId, turn_id: input.turnId, message: input.message, input_fingerprint: input.inputFingerprint, state: "running" }).execute();
        return this.startClaims(trx, sides, input, 1);
      }
      if (turn.input_fingerprint !== input.inputFingerprint) return "turn_conflict";
      if (!input.retry) return await this.replayCompletedClaims(trx, sides, input) ?? "turn_conflict";
      return this.recoverRetryClaim(trx, sides[0], input, turn.state);
    });
  }

  async complete(input: CompleteInput): Promise<"stale" | TestExecution> { return this.finish(input, "completed"); }
  async fail(input: FailInput): Promise<"stale" | TestExecution> { return this.finish(input, "failed"); }

  private async startClaims(trx: TransactionDb, sides: ReadonlyArray<{ id: string; active_fence: number | null; history: unknown }>, input: ClaimInput, minimumFence: number): Promise<{ claims: TestExecutionClaim[] }> {
    const claims: TestExecutionClaim[] = [];
    for (const side of sides) {
      const fence = Math.max(minimumFence, (side.active_fence ?? 0) + 1);
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      await trx.insertInto("agent_test_execution_attempts").values({ execution_id: input.executionId, side_id: side.id, turn_id: input.turnId, attempt_id: input.attemptId, input_fingerprint: input.inputFingerprint, fence, state: "running", lease_expires_at: leaseExpiresAt, result: null, failure_code: null }).execute();
      await trx.updateTable("agent_test_execution_sides").set({ state: "running", retryable: false, history: toJsonb(appendUser(parseHistory(side.history), input)), active_turn_id: input.turnId, active_attempt_id: input.attemptId, active_fence: fence, updated_at: currentTimestamp() }).where("id", "=", side.id).execute();
      claims.push({ sideId: side.id, attempt: { executionId: input.executionId, sideId: side.id, turnId: input.turnId, attemptId: input.attemptId, message: input.message, inputFingerprint: input.inputFingerprint, fence, leaseExpiresAt, state: "running" } });
    }
    await trx.updateTable("agent_test_execution_turns").set({ state: "running", updated_at: currentTimestamp() }).where("execution_id", "=", input.executionId).where("turn_id", "=", input.turnId).execute();
    await trx.updateTable("agent_test_executions").set({ state: "running", updated_at: currentTimestamp() }).where("id", "=", input.executionId).execute();
    return { claims };
  }

  private async replayCompletedClaims(trx: TransactionDb, sides: ReadonlyArray<{ id: string; active_attempt_id: string | null }>, input: ClaimInput): Promise<{ claims: TestExecutionClaim[] } | null> {
    const claims: TestExecutionClaim[] = [];
    for (const side of sides) {
      if (side.active_attempt_id !== null) return null;
      const completed = await trx.selectFrom("agent_test_execution_attempts").selectAll().where("execution_id", "=", input.executionId).where("side_id", "=", side.id).where("turn_id", "=", input.turnId).where("attempt_id", "=", input.attemptId).where("state", "=", "completed").forUpdate().executeTakeFirst();
      const result = completed ? parseResult(completed.result) : undefined;
      if (!completed || !result) return null;
      claims.push({ sideId: side.id, attempt: this.mapAttempt(completed, input.message), replay: result });
    }
    return { claims };
  }

  private async recoverRetryClaim(trx: TransactionDb, side: { id: string; active_attempt_id: string | null; active_turn_id: string | null; active_fence: number | null; state: string; history: unknown }, input: ClaimInput, turnState: string): Promise<Awaited<ReturnType<TestExecutionRepositoryPort["claimTurn"]>>> {
    const requested = await trx.selectFrom("agent_test_execution_attempts").selectAll().where("execution_id", "=", input.executionId).where("side_id", "=", side.id).where("turn_id", "=", input.turnId).where("attempt_id", "=", input.attemptId).forUpdate().executeTakeFirst();
    if (requested) {
      const result = requested.state === "completed" ? parseResult(requested.result) : undefined;
      return result ? { claims: [{ sideId: side.id, attempt: this.mapAttempt(requested, input.message), replay: result }] } : "attempt_conflict";
    }
    const latest = await trx.selectFrom("agent_test_execution_attempts").selectAll().where("execution_id", "=", input.executionId).where("side_id", "=", side.id).where("turn_id", "=", input.turnId).orderBy("fence", "desc").forUpdate().executeTakeFirst();
    if (!latest) return "retry_invalid";
    if (latest.state === "completed") {
      const newerActiveTurn = await trx.selectFrom("agent_test_execution_turns")
        .select("turn_id")
        .where("execution_id", "=", input.executionId)
        .where("turn_id", "!=", input.turnId)
        .where("state", "=", "running")
        .executeTakeFirst();
      const result = parseResult(latest.result);
      if (newerActiveTurn || !result || side.active_attempt_id !== null) return "attempt_conflict";
      return {
        claims: [{
          sideId: side.id,
          // This is a delivery claim: preserve durable history and result, but fence SSE to the new request identity.
          attempt: { ...this.mapAttempt(latest, input.message), attemptId: input.attemptId },
          replay: result,
        }],
      };
    }
    if (side.active_attempt_id !== null) {
      if (side.active_turn_id !== input.turnId || latest.state !== "running" || latest.lease_expires_at > input.now) return "turn_conflict";
      await trx.updateTable("agent_test_execution_attempts").set({ state: "failed", failure_code: "lease_expired", updated_at: currentTimestamp() }).where("execution_id", "=", input.executionId).where("side_id", "=", side.id).where("turn_id", "=", input.turnId).where("attempt_id", "=", side.active_attempt_id).execute();
    } else if (turnState !== "partial" || side.state !== "failed") return "retry_invalid";
    return this.startClaims(trx, [side], input, (side.active_fence ?? latest.fence) + 1);
  }

  private async finish(input: CompleteInput | FailInput, state: "completed" | "failed"): Promise<"stale" | TestExecution> {
    const changed = await this.db.transaction().execute(async (trx) => {
      const execution = await trx.selectFrom("agent_test_executions").selectAll().where("id", "=", input.executionId).where("workspace_id", "=", input.workspaceId).where("agent_id", "=", input.agentId).forUpdate().executeTakeFirst();
      if (!execution) return false;
      const side = await trx.selectFrom("agent_test_execution_sides").selectAll().where("id", "=", input.sideId).where("execution_id", "=", input.executionId).where("workspace_id", "=", input.workspaceId).where("agent_id", "=", input.agentId).forUpdate().executeTakeFirst();
      if (!side || side.active_turn_id !== input.turnId || side.active_attempt_id !== input.attemptId || side.active_fence !== input.fence) return false;
      const attempt = await trx.selectFrom("agent_test_execution_attempts").selectAll().where("execution_id", "=", input.executionId).where("side_id", "=", input.sideId).where("turn_id", "=", input.turnId).where("attempt_id", "=", input.attemptId).forUpdate().executeTakeFirst();
      if (!attempt || attempt.state !== "running" || attempt.fence !== input.fence) return false;
      const result = "result" in input ? input.result : undefined;
      await trx.updateTable("agent_test_execution_attempts").set({ state, result: result ? toJsonb(result) : null, failure_code: "code" in input ? input.code : null, lease_expires_at: input.now, updated_at: currentTimestamp() }).where("execution_id", "=", input.executionId).where("side_id", "=", input.sideId).where("turn_id", "=", input.turnId).where("attempt_id", "=", input.attemptId).execute();
      await trx.updateTable("agent_test_execution_sides").set({ state, retryable: state === "failed", history: toJsonb(state === "completed" && result ? appendAssistant(parseHistory(side.history), input as CompleteInput) : parseHistory(side.history)), continuation: state === "completed" && result ? toJsonb(result.continuation) : side.continuation, active_turn_id: null, active_attempt_id: null, active_fence: null, updated_at: currentTimestamp() }).where("id", "=", side.id).execute();
      const allSides = await trx.selectFrom("agent_test_execution_sides").select("state").where("execution_id", "=", input.executionId).execute();
      const executionState: TestExecutionState = allSides.every((item) => item.state === "completed") ? "completed" : allSides.some((item) => item.state === "running" || item.state === "ready") ? "running" : "partial";
      const turnState = executionState === "completed" ? "completed" : executionState === "running" ? "running" : "partial";
      await trx.updateTable("agent_test_execution_turns").set({ state: turnState, updated_at: currentTimestamp() }).where("execution_id", "=", input.executionId).where("turn_id", "=", input.turnId).execute();
      await trx.updateTable("agent_test_executions").set({ state: executionState, updated_at: currentTimestamp() }).where("id", "=", input.executionId).execute();
      return true;
    });
    if (!changed) return "stale";
    return (await this.find({ workspaceId: input.workspaceId, agentId: input.agentId, executionId: input.executionId })) ?? "stale";
  }

  private mapAttempt(row: { execution_id: string; side_id: string; turn_id: string; attempt_id: string; input_fingerprint: string; fence: number; lease_expires_at: Date; state: string; result: unknown }, message: string): TestExecutionAttempt {
    return { executionId: row.execution_id, sideId: row.side_id, turnId: row.turn_id, attemptId: row.attempt_id, message, inputFingerprint: row.input_fingerprint, fence: row.fence, leaseExpiresAt: new Date(row.lease_expires_at), state: row.state as TestExecutionAttempt["state"], result: parseResult(row.result) };
  }
}
