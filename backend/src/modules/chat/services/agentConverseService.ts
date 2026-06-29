import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import { serviceUnavailable } from "../../../shared/domain/errors.js";
import type { AssistantChatService } from "./assistantChatService.js";
import type { AgentConversePrincipal } from "../../settings/contracts/agentConverseSession.js";
import type { AgentConverseAudit } from "./agentConverseAudit.js";

export interface AgentConverseAskResult {
  conversationId: string;
  answer: {
    text: string;
    citations: unknown[];
  };
  traceId?: string;
}

export class AgentConverseService {
  constructor(
    private readonly dependencies: {
      assistantChatService: Pick<AssistantChatService, "answer">;
      conversationRepository: Pick<ConversationRepositoryPort, "listPageByAnonymousSession">;
      audit?: AgentConverseAudit;
    },
  ) {}

  async askAgent(principal: AgentConversePrincipal, input: { message: string; stream?: boolean }): Promise<AgentConverseAskResult> {
    try {
      const existing = await this.dependencies.conversationRepository.listPageByAnonymousSession(
        principal.workspaceId,
        principal.publicSessionId,
        { limit: 1, agentId: principal.agentId },
      );
      const conversationId = existing.conversations[0]?.id;
      const response = await this.dependencies.assistantChatService.answer({
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        message: input.message,
        stream: false,
        conversationId,
        anonymousSessionId: principal.publicSessionId,
        sourceChannel: "mcp",
        sourceOrigin: null,
      });
      if (!response) {
        throw serviceUnavailable("MCP converse response is unavailable.", {
          code: "mcp_converse_empty_response",
        });
      }

      await this.dependencies.audit?.recordAskOutcome({
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        grantId: principal.grantId,
        publicSessionId: principal.publicSessionId,
        status: "success",
      });

      return {
        conversationId: principal.publicSessionId,
        answer: {
          text: response.answer,
          citations: response.citations ?? [],
        },
      };
    } catch (error) {
      await this.dependencies.audit?.recordAskOutcome({
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        grantId: principal.grantId,
        publicSessionId: principal.publicSessionId,
        status: "failure",
        reason: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }
}
