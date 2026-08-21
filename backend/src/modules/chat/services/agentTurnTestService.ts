import { badRequest, notFound, serviceUnavailable } from "../../../shared/domain/errors.js";
import { OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";
import type {
  AgentTurnTestInput,
  AgentTurnTestPort,
  AgentTurnTestResult,
  AgentTurnTestServiceDependencies,
} from "../contracts/agentTurnTest.js";

export { OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";

const MAX_PREVIEW_ROUTINES = 20;
const PREVIEW_ELIGIBLE_STATUSES = new Set(["draft", "published"]);

const probeSourceOrigin = (input: Pick<
  AgentTurnTestInput,
  "operatorUserId" | "copilotConversationId"
>): string =>
  `operator:${input.operatorUserId}:copilot_conversation:${input.copilotConversationId}`;

export class AgentTurnTestService implements AgentTurnTestPort {
  constructor(private readonly dependencies: AgentTurnTestServiceDependencies) {}

  async testTurn(input: AgentTurnTestInput): Promise<AgentTurnTestResult> {
    const query = input.message.trim();
    if (!query) {
      throw badRequest("message is required");
    }
    const previewRoutineIds = [...new Set(input.previewRoutineIds ?? [])];
    if (previewRoutineIds.length > MAX_PREVIEW_ROUTINES) {
      throw badRequest(`previewRoutineIds cannot contain more than ${MAX_PREVIEW_ROUTINES} items`);
    }

    await this.enforceAbuseControl(input);
    const sourceOrigin = probeSourceOrigin(input);
    await this.preflight(input, sourceOrigin, previewRoutineIds);

    const response = await this.dependencies.turnRunner.run({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      query,
      userExpectedLocale: input.userExpectedLocale,
      inputMetadata: input.inputMetadata,
      pageContext: input.pageContext,
      clientContextCapabilities: input.clientContextCapabilities,
      previewRoutineIds,
      sourceChannel: OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL,
      sourceOrigin,
      usageAttribution: {
        surface: OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL,
        requestId: input.copilotConversationId,
      },
    });
    const userMessageId = await this.findTurnUserMessageId(input.workspaceId, response);

    return {
      conversationId: response.conversationId,
      userMessageId,
      assistantMessageId: response.assistantMessageId,
      agentId: response.agentId,
      answer: response.answer,
      citations: response.citations,
      skillOutcome: response.skillOutcome,
      answerOutcome: response.answerOutcome,
      activitySummary: response.activitySummary,
      activityTrace: response.activityTrace,
      turnTrace: response.turnTrace,
    };
  }

  private async enforceAbuseControl(input: AgentTurnTestInput): Promise<void> {
    const scope = "api.expensive_authenticated";
    const subjectKey = `account:${input.accountId}:workspace:${input.workspaceId}:operator:${input.operatorUserId}`;
    try {
      await this.dependencies.abuseControl.enforce({
        scope,
        subjectKey,
        ...this.dependencies.abusePolicy,
      });
    } catch (error) {
      const statusCode = error && typeof error === "object" && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
      if (statusCode === 429 || statusCode === 503) {
        await this.dependencies.audit.record({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: statusCode === 429
            ? "security.rate_limit_enforced"
            : "security.rate_limit_unavailable",
          eventStatus: statusCode === 429 ? "success" : "failure",
          metadata: {
            scope,
            subjectKey,
            principalType: "operator_copilot",
            route: "test_agent_turn",
          },
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async preflight(
    input: AgentTurnTestInput,
    sourceOrigin: string,
    previewRoutineIds: readonly string[],
  ): Promise<void> {
    if (input.conversationId) {
      const conversation = await this.dependencies.conversationReader.findByIdAndWorkspaceId(
        input.conversationId,
        input.workspaceId,
      );
      if (
        !conversation ||
        conversation.workspaceId !== input.workspaceId ||
        conversation.agentId !== input.agentId ||
        conversation.sourceChannel !== OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL ||
        conversation.sourceOrigin !== sourceOrigin
      ) {
        throw notFound("Test conversation not found");
      }
    }

    const agent = await this.dependencies.agentReader.findByIdAndWorkspaceId(
      input.agentId,
      input.workspaceId,
    );
    if (!agent) {
      throw notFound("Agent not found");
    }

    for (const routineId of previewRoutineIds) {
      const routine = await this.dependencies.routineReader.findById(input.agentId, routineId);
      if (!routine || !PREVIEW_ELIGIBLE_STATUSES.has(routine.status)) {
        throw notFound("Preview routine not found");
      }
    }
  }

  private async findTurnUserMessageId(
    workspaceId: string,
    response: { conversationId: string; assistantMessageId: string },
  ): Promise<string> {
    const assistantMessage = await this.dependencies.messageReader.findByIdAndWorkspaceId(
      workspaceId,
      response.assistantMessageId,
    );
    const userMessageId = assistantMessage?.metadata?.probeUserMessageId;
    if (
      assistantMessage?.role === "assistant" &&
      typeof userMessageId === "string" &&
      userMessageId.length > 0
    ) {
      return userMessageId;
    }
    throw serviceUnavailable("Test turn result is unavailable");
  }
}
