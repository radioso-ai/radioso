import { badRequest } from "../../../shared/domain/errors.js";
import { USAGE_LIMIT_EXCEEDED_CODE } from "../../../shared/domain/usageLimitPolicy.js";
import type { AgentRevision } from "../../agents/public.js";
import type { TestExecution, TestExecutionTranscriptSide, TestExecutionTurn } from "../../test-execution/public.js";
import type { CopilotTestChatPort as Port, CopilotTestChatSendInput, CopilotTestChatSendResult, TestChatServiceDependencies } from "../contracts/testChat.js";
import { CopilotUsageLimitReachedError, enforceCopilotExpensiveOperation, withCopilotSpendRefusals } from "./expensiveOperationGuard.js";

const presentRevision = (revision: Pick<AgentRevision, "id" | "createdAt" | "publishedAt" | "publishedVersion">) => ({
  id: revision.id, kind: revision.publishedAt ? "published" as const : "candidate" as const, versionNumber: revision.publishedVersion, createdAt: revision.createdAt.toISOString(),
});
const presentSide = (side: Pick<TestExecutionTranscriptSide, "id" | "state"> & { revision: Parameters<typeof presentRevision>[0] }) => ({ sideId: side.id, revision: presentRevision(side.revision), state: side.state });
const presentHeader = (execution: Pick<TestExecution, "id" | "mode" | "state" | "skillEffects" | "createdAt">) => ({
  testExecutionId: execution.id, mode: execution.mode, state: execution.state, skillEffects: execution.skillEffects, createdAt: execution.createdAt.toISOString(),
});
const presentTurn = (turn: TestExecutionTurn) => ({ ...turn, createdAt: turn.createdAt.toISOString() });

/** Test Chat over test-execution's own reads and calls. Sessions started here suppress outward skill effects, so a turn stays a probe. */
export class TestChatService implements Port {
  constructor(private readonly dependencies: TestChatServiceDependencies) {}

  async listSessions({ workspaceId, agentId, limit, cursor }: Parameters<Port["listSessions"]>[0]): ReturnType<Port["listSessions"]> {
    const page = await this.dependencies.executions.summaries({ workspaceId, agentId, limit, ...(cursor ? { cursor } : {}) });
    return { sessions: page.executions.map((item) => ({ ...presentHeader(item), sides: item.sides.map(presentSide), turnCount: item.turnCount, firstMessage: item.firstMessage })), nextCursor: page.nextCursor };
  }

  async readSession({ workspaceId, agentId, testExecutionId }: Parameters<Port["readSession"]>[0]): ReturnType<Port["readSession"]> {
    const transcript = await this.dependencies.executions.transcript({ workspaceId, agentId, executionId: testExecutionId });
    return { ...presentHeader(transcript), sides: transcript.sides.map((side) => ({ ...presentSide(side), turns: side.turns.map(presentTurn) })) };
  }

  async readTurn({ testExecutionId, ...input }: Parameters<Port["readTurn"]>[0]): ReturnType<Port["readTurn"]> {
    const { executionId, side, turn } = await this.dependencies.executions.turn({ ...input, executionId: testExecutionId });
    return { testExecutionId: executionId, sideId: side.id, revision: presentRevision(side.revision), turn: presentTurn(turn) };
  }

  async sendMessage(input: CopilotTestChatSendInput): Promise<CopilotTestChatSendResult> {
    const { workspaceId, agentId, accountId } = input;
    const message = input.message.trim();
    if (!message) throw badRequest("message is required");
    if (input.testExecutionId && input.revisionId) throw badRequest("revisionId chooses the revision a new session starts on; a session continues on the revision it started with, so send testExecutionId or revisionId, not both.");
    // Refusals that need only a read come before the spend, so a wrong session id costs nothing.
    const continued = input.testExecutionId ? await this.continuableSession({ workspaceId, agentId, executionId: input.testExecutionId }) : null;
    await enforceCopilotExpensiveOperation(this.dependencies, input, "send_test_chat_message");
    return withCopilotSpendRefusals(async () => {
      // Without a revision, test-execution starts on the agent's default one, as the dashboard does.
      const revision = input.revisionId ? { revisionIds: [input.revisionId] } : {};
      const execution = continued ?? await this.dependencies.executions.start({ workspaceId, agentId, accountId, mode: "single", ...revision, testValues: [], idempotencyKey: this.dependencies.createId(), skillEffects: "suppressed" });
      const turnId = this.dependencies.createId();
      const { side, turn } = await this.dependencies.executions.send({ workspaceId, agentId, accountId, executionId: execution.id, message, generation: execution.generation, turnId, attemptId: this.dependencies.createId() });
      // The session records the refused turn; the caller gets the same refusal every probe gives.
      if (turn.failureCode === USAGE_LIMIT_EXCEEDED_CODE) throw new CopilotUsageLimitReachedError();
      return {
        testExecutionId: execution.id, started: continued === null, sideId: side.id, revision: presentRevision(side.revision), turnId,
        outcome: turn.state === "completed" ? "completed" : "failed", failureCode: turn.failureCode,
        answer: turn.answer?.content ?? null, messageId: turn.answer?.messageId ?? null, turnTrace: turn.turnTrace,
      };
    });
  }

  private async continuableSession(input: { workspaceId: string; agentId: string; executionId: string }): Promise<Pick<TestExecution, "id" | "generation">> {
    const session = await this.dependencies.executions.transcript(input);
    if (session.mode !== "single") throw badRequest("This Test Chat session compares two revisions, and a comparison continues in the dashboard. Start a new session here, or continue this one there.");
    // Skill effects are frozen per session. A session that lets skills act outward would turn this
    // probe into an act, so it continues only where an operator started it.
    if (session.skillEffects !== "suppressed") throw badRequest("This Test Chat session lets skills act outward, so it continues only in the dashboard. Start a new session here; it runs with skill effects suppressed.");
    return session;
  }
}
