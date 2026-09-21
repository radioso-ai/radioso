import type { ChatResponse } from "../types/chatResponses.js";
import type { AssistantClientContextCapabilities } from "../types/assistantApi.js";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

export type {
  AssistantClientContextCapabilities,
  AssistantPageContext,
} from "../types/assistantApi.js";
export type {
  AnswerSegment,
  ChatCitation,
} from "./answerTypes.js";
export type {
  PublicChatActionAdvertiserPort,
} from "../services/publicChatActionAdvertiser.js";
export type { ChatGateway } from "./chatGateway.js";
// Read-only conversation starters (greeting chips) for channels that show them outside a
// conversation, such as Slack's agent pane; the connector registry carries this port.
export type { AgentStarterPromptReader } from "./agentStarterPrompts.js";
export type { WorkbenchReplayResult } from "../services/workbenchReplayRunner.js";
export type { PublicConversationEventBus } from "../services/publicConversationEventBus.js";
export { SKILL_TURN_OUTCOME } from "../services/assistantTurnOutcomeTypes.js";
// The contact.send action type is a chat contract shared with the notify capability; exposed
// here (not via chat/composition) so cross-module consumers stay off the app-wiring entrypoint.
export { CONTACT_SEND_ACTION_TYPE } from "../services/routines/contactRoutine.js";
export { appendDirectiveSteeringStage } from "../services/directiveTracePresenter.js";
export { appendConversationSummaryStage } from "../services/conversationSummaryTracePresenter.js";
export type { TurnTraceEnvelope } from "../services/turnTraceEnvelope.js";
export type { GroundingSummary } from "../services/groundingAssertions.js";
export type { ChatConversationDetail, ChatConversationTail } from "../services/chatHistoryService.js";
export type { ProbeConversationReadPort } from "../services/probeConversationReader.js";
export type { ChatActionSuggestionProvider } from "../services/actionSuggestions/chatActionSuggestionProvider.js";
// The MCP converse HTTP surface holds these instances; composition builds them.
export type { AgentConverseAudit } from "../services/agentConverseAudit.js";
export type {
  AgentConverseAskResult,
  AgentConverseService,
} from "../services/agentConverseService.js";
// The agent reply envelope is shared by the MCP converse route, the REST agent
// chat route, and the SSE presenter; composition never builds it.
export { buildAgentReplyEnvelope, isChatTurnResponse } from "../services/agentReplyEnvelope.js";
// Both agent-facing doors resolve a turn's input (message or tool call) through
// this before any turn state is written; neither transport validates on its own.
export { chatRequestInputFor, resolveAgentTurnInput, type AgentTurnInput } from "../services/agentTurnInput.js";
export type { ChatRoutineTurnState } from "./routineTurnState.js";
export type { ChatStreamEvent } from "./streamEvents.js";
export type {
  ActionHandler,
  ActionHandlerContext,
} from "../services/actions/actionDispatcher.js";
export { CitationAnchorSanitizer } from "../services/citationAnchorSanitizer.js";
export type {
  ContactHistoryProviderPort,
} from "../services/contactHistoryProvider.js";
export type {
  ChatOwnershipAck,
  ChatResponse,
  ChatRoute,
  ChatSuggestion,
} from "../types/chatResponses.js";
export type {
  ChatAnswerCoverageAssessment,
  ChatAnswerCoverageInteractionTrace,
} from "./answerCoverage.js";
export interface ChatAnswerPort {
  answer(input: {
    workspaceId: string;
    agentId?: string | null;
    accountId?: string;
    conversationId?: string;
    query: string;
    stream: boolean;
    userExpectedLocale?: string | null;
    inputMetadata?: unknown;
    metadataFilter?: Record<string, unknown>;
    pageContext?: unknown;
    clientContextCapabilities?: AssistantClientContextCapabilities;
    sourceChannel?: string | null;
    channelContext?: ConversationChannelContext | null;
    chatSessionId?: string | null;
    /** @deprecated Use chatSessionId. */
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
  }): Promise<ChatResponse>;
}
