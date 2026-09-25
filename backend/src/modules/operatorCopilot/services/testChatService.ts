import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { USAGE_LIMIT_EXCEEDED_CODE } from "../../../shared/domain/usageLimitPolicy.js";
import type { AgentRevision } from "../../agents/public.js";
import type { TestExecution, TestExecutionAttemptRecord, TestExecutionEvent } from "../../test-execution/public.js";
import type {
  CopilotTestChatPort,
  CopilotTestChatRevision,
  CopilotTestChatSendInput,
  CopilotTestChatSendResult,
  CopilotTestChatSession,
  CopilotTestChatSessionSummary,
  CopilotTestChatTurn,
  CopilotTestChatTurnDetail,
  TestChatServiceDependencies,
} from "../contracts/testChat.js";
import { CopilotUsageLimitReachedError, enforceCopilotExpensiveOperation, withCopilotSpendRefusals } from "./expensiveOperationGuard.js";

type ExecutionSide = TestExecution["sides"][number];
type HistoryEntry = ExecutionSide["history"][number];

const presentRevision = (revision: Pick<AgentRevision, "id" | "createdAt" | "publishedAt" | "publishedVersion">): CopilotTestChatRevision => ({
  id: revision.id,
  kind: revision.publishedAt ? "published" : "candidate",
  versionNumber: revision.publishedVersion,
  createdAt: revision.createdAt.toISOString(),
});

/** The attempt with the highest fence is the one a turn's current state belongs to. */
const latestAttempts = (attempts: readonly TestExecutionAttemptRecord[], sideId: string): Map<string, TestExecutionAttemptRecord> => {
  const latest = new Map<string, TestExecutionAttemptRecord>();
  for (const attempt of attempts) {
    if (attempt.sideId !== sideId) continue;
    const current = latest.get(attempt.turnId);
    if (!current || attempt.fence > current.fence) latest.set(attempt.turnId, attempt);
  }
  return latest;
};

interface GroupedTurn { turnId: string; opening: HistoryEntry; user?: HistoryEntry; assistant?: HistoryEntry }

const groupTurns = (history: readonly HistoryEntry[]): GroupedTurn[] => {
  const turns = new Map<string, GroupedTurn>();
  for (const entry of history) {
    const turn = turns.get(entry.turnId) ?? { turnId: entry.turnId, opening: entry };
    if (entry.role === "user") turn.user ??= entry;
    else turn.assistant = entry;
    turns.set(entry.turnId, turn);
  }
  return [...turns.values()];
};

const presentTurns = (side: ExecutionSide, attempts: readonly TestExecutionAttemptRecord[]): CopilotTestChatTurn[] => {
  const latest = latestAttempts(attempts, side.id);
  return groupTurns(side.history).map(({ turnId, opening, user, assistant }) => {
    const attempt = latest.get(turnId);
    const state: CopilotTestChatTurn["state"] = assistant
      ? "completed"
      : attempt?.state === "running" ? "running" : attempt?.state === "failed" ? "failed" : "unanswered";
    return {
      turnId,
      userMessage: user?.content ?? null,
      answer: assistant ? { messageId: assistant.messageId ?? null, content: assistant.content } : null,
      state,
      failureCode: state === "failed" ? attempt?.failureCode ?? null : null,
      createdAt: opening.createdAt.toISOString(),
      turnTrace: assistant?.turnTrace,
    };
  });
};

const presentSide = (side: ExecutionSide) => ({ sideId: side.id, revision: presentRevision(side.revision), state: side.state });

const presentHeader = (execution: TestExecution) => ({
  testExecutionId: execution.id,
  mode: execution.mode,
  state: execution.state,
  skillEffects: execution.skillEffects,
  createdAt: execution.createdAt.toISOString(),
});

const presentSummary = (execution: TestExecution): CopilotTestChatSessionSummary => {
  // Comparison sides answer the same aligned messages, so the first side speaks for the session.
  const userMessages = (execution.sides[0]?.history ?? []).filter((entry) => entry.role === "user");
  return {
    ...presentHeader(execution),
    sides: execution.sides.map(presentSide),
    turnCount: new Set(userMessages.map((entry) => entry.turnId)).size,
    firstMessage: userMessages[0]?.content ?? null,
  };
};

/**
 * Operator Copilot's Test Chat: the dashboard's private, revision-pinned test surface, read and
 * driven through the same owner calls the dashboard makes. Sessions started here always suppress
 * outward skill effects, so a turn stays a probe.
 */
export class TestChatService implements CopilotTestChatPort {
  constructor(private readonly dependencies: TestChatServiceDependencies) {}

  async listSessions(input: Parameters<CopilotTestChatPort["listSessions"]>[0]): ReturnType<CopilotTestChatPort["listSessions"]> {
    const { workspaceId, agentId } = input;
    const page = await this.dependencies.executions.list({ workspaceId, agentId, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) });
    // The list projection carries no transcript, and a session's opening message is what tells an
    // operator which one they ran. The page is small and bounded by the caller's limit.
    const details = await Promise.all(page.executions.map((item) => this.dependencies.executions.detail({ workspaceId, agentId, executionId: item.id })));
    return { sessions: details.map(({ execution }) => presentSummary(execution)), nextCursor: page.nextCursor };
  }

  async readSession(input: Parameters<CopilotTestChatPort["readSession"]>[0]): Promise<CopilotTestChatSession> {
    const { execution, attempts } = await this.dependencies.executions.detail({ workspaceId: input.workspaceId, agentId: input.agentId, executionId: input.testExecutionId });
    return {
      ...presentHeader(execution),
      sides: execution.sides.map((side) => ({ ...presentSide(side), turns: presentTurns(side, attempts) })),
    };
  }

  async readTurn(input: Parameters<CopilotTestChatPort["readTurn"]>[0]): Promise<CopilotTestChatTurnDetail> {
    const { execution, attempts } = await this.dependencies.executions.detail({ workspaceId: input.workspaceId, agentId: input.agentId, executionId: input.testExecutionId });
    const side = input.sideId ? execution.sides.find((candidate) => candidate.id === input.sideId) : execution.sides[0];
    if (!side) throw notFound("Test Chat side is unavailable.");
    const turn = presentTurns(side, attempts).find((candidate) => candidate.turnId === input.turnId);
    if (!turn) throw notFound("Test Chat turn is unavailable.");
    return { testExecutionId: execution.id, sideId: side.id, revision: presentRevision(side.revision), turn };
  }

  async sendMessage(input: CopilotTestChatSendInput): Promise<CopilotTestChatSendResult> {
    const message = input.message.trim();
    if (!message) throw badRequest("message is required");
    if (input.testExecutionId && input.revisionId) {
      throw badRequest("revisionId chooses the revision a new session starts on; a session continues on the revision it started with, so send testExecutionId or revisionId, not both.");
    }
    // Refusals that need only a read come before the spend, so a wrong session id costs nothing.
    const continued = input.testExecutionId ? await this.continuableSession(input, input.testExecutionId) : null;
    await enforceCopilotExpensiveOperation(this.dependencies, input, "send_test_chat_message");
    return withCopilotSpendRefusals(async () => {
      const execution = continued ?? await this.startSession(input);
      const turnId = this.dependencies.createId();
      const events = await this.dependencies.executions.message({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        accountId: input.accountId,
        executionId: execution.id,
        message,
        generation: execution.generation,
        turnId,
        attemptId: this.dependencies.createId(),
      });
      return this.presentSend(execution, events, turnId, continued === null);
    });
  }

  private async continuableSession(input: CopilotTestChatSendInput, executionId: string): Promise<TestExecution> {
    const { execution } = await this.dependencies.executions.detail({ workspaceId: input.workspaceId, agentId: input.agentId, executionId });
    if (execution.mode !== "single") {
      throw badRequest("This Test Chat session compares two revisions, and a comparison continues in the dashboard. Start a new session here, or continue this one there.");
    }
    // Skill effects are frozen per session. A session that lets skills act outward would turn this
    // probe into an act, so it continues only where an operator started it.
    if (execution.skillEffects !== "suppressed") {
      throw badRequest("This Test Chat session lets skills act outward, so it continues only in the dashboard. Start a new session here; it runs with skill effects suppressed.");
    }
    return execution;
  }

  private async startSession(input: CopilotTestChatSendInput): Promise<TestExecution> {
    const selection = input.revisionId ? { revisionId: input.revisionId } : await this.draftSelection(input);
    return this.dependencies.executions.start({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      accountId: input.accountId,
      mode: "single",
      revisionIds: [selection.revisionId],
      testValues: [],
      ...("expectedDraftGeneration" in selection ? { expectedDraftGeneration: selection.expectedDraftGeneration } : {}),
      idempotencyKey: this.dependencies.createId(),
      skillEffects: "suppressed",
    });
  }

  /**
   * The dashboard's default selection: a fresh candidate of the saved draft, or the published
   * revision when the draft holds exactly what is published. An agent that was never published has
   * only its candidate to test.
   */
  private async draftSelection(input: CopilotTestChatSendInput): Promise<{ revisionId: string; expectedDraftGeneration: number }> {
    const state = await this.dependencies.revisions.state(input.workspaceId, input.agentId);
    const expectedDraftGeneration = state.draft.generation;
    if (state.status === "draft_clean" && state.publishedRevision) {
      return { revisionId: state.publishedRevision.id, expectedDraftGeneration };
    }
    const candidate = await this.dependencies.revisions.createCandidate(input.workspaceId, input.agentId, expectedDraftGeneration);
    return { revisionId: candidate.id, expectedDraftGeneration };
  }

  private presentSend(execution: TestExecution, events: readonly TestExecutionEvent[], turnId: string, started: boolean): CopilotTestChatSendResult {
    const side = execution.sides[0];
    if (!side) throw new Error("Test Chat session has no side to report");
    let answer: string | null = null;
    for (const event of events) {
      if (event.type === "message_delta" && event.sideId === side.id) answer = (answer ?? "") + event.delta;
    }
    const settled = events.find((event) => (event.type === "side_completed" || event.type === "side_failed") && event.sideId === side.id);
    const base = { testExecutionId: execution.id, started, sideId: side.id, revision: presentRevision(side.revision), turnId };
    if (settled?.type === "side_completed") {
      return { ...base, outcome: "completed", failureCode: null, answer: answer ?? "", messageId: settled.messageId, turnTrace: settled.turnTrace };
    }
    if (settled?.type === "side_failed") {
      // The session records the refused turn; the caller gets the same refusal every probe gives.
      if (settled.code === USAGE_LIMIT_EXCEEDED_CODE) throw new CopilotUsageLimitReachedError();
      return { ...base, outcome: "failed", failureCode: settled.code, answer: null, messageId: null, turnTrace: undefined };
    }
    throw new Error("Test Chat turn settled without an outcome");
  }
}
