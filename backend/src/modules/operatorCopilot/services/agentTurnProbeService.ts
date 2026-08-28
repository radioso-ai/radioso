import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";
import type {
  AgentTurnProbeServiceDependencies,
  CopilotAgentTurnProbeInput,
  CopilotAgentTurnProbePort,
  CopilotAgentTurnProbeResult,
} from "../contracts/agentTurnProbe.js";
import { enforceCopilotExpensiveOperation } from "./expensiveOperationGuard.js";

export { OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";

const MAX_PREVIEW_ROUTINES = 20;
const PREVIEW_ELIGIBLE_STATUSES = new Set(["draft", "published"]);

const probeSourceOrigin = (input: Pick<
  CopilotAgentTurnProbeInput,
  "operatorUserId" | "copilotConversationId"
>): string =>
  `operator:${input.operatorUserId}:copilot_conversation:${input.copilotConversationId}`;

export class AgentTurnProbeService implements CopilotAgentTurnProbePort {
  constructor(private readonly dependencies: AgentTurnProbeServiceDependencies) {}

  async testTurn(input: CopilotAgentTurnProbeInput): Promise<CopilotAgentTurnProbeResult> {
    const query = input.message.trim();
    if (!query) {
      throw badRequest("message is required");
    }
    const previewRoutineIds = [...new Set(input.previewRoutineIds ?? [])];
    if (previewRoutineIds.length > MAX_PREVIEW_ROUTINES) {
      throw badRequest(`previewRoutineIds cannot contain more than ${MAX_PREVIEW_ROUTINES} items`);
    }

    await enforceCopilotExpensiveOperation(this.dependencies, input, "test_agent_turn");
    const sourceOrigin = probeSourceOrigin(input);
    await this.preflight(input, sourceOrigin, previewRoutineIds);

    return this.dependencies.turnRunner.run({
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
  }

  private async preflight(
    input: CopilotAgentTurnProbeInput,
    sourceOrigin: string,
    previewRoutineIds: readonly string[],
  ): Promise<void> {
    if (input.conversationId) {
      const conversation = await this.dependencies.conversationReader.findProbeConversation(
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

    const agent = await this.dependencies.agentReader.findAgentForProbe(
      input.agentId,
      input.workspaceId,
    );
    if (!agent) {
      throw notFound("Agent not found");
    }

    for (const routineId of previewRoutineIds) {
      const routine = await this.dependencies.routineReader.findPreviewRoutine(input.workspaceId, input.agentId, routineId);
      if (!routine || !PREVIEW_ELIGIBLE_STATUSES.has(routine.status)) {
        throw notFound("Preview routine not found");
      }
    }
  }
}
