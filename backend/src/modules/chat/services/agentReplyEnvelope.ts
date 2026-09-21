import type { ChatAnswerCoverageAssessment } from "../contracts/answerCoverage.js";
import type { ChatRoutineTurnState } from "../contracts/routineTurnState.js";
import type { ChatOwnershipAck, ChatResponse } from "../types/chatResponses.js";
import type { AssistantChatResponse } from "../types/assistantApi.js";

/**
 * The part of a reply a calling agent acts on, shared verbatim by the MCP
 * `ask` route and the REST agent chat route (JSON body and SSE `done` frame).
 * The answer text and citations sit beside it in each route's own layout.
 */
export interface AgentReplyEnvelopeCore {
  conversationId: string;
  answerCoverage: ChatAnswerCoverageAssessment;
  ownership: ChatOwnershipAck;
  routine?: ChatRoutineTurnState;
  traceId?: string;
}

/** Satisfied by both a `ChatResponse` and the stream's `done` event. */
type AgentReplyEnvelopeSource = Pick<
  ChatResponse,
  "conversationId" | "answerCoverage" | "ownership" | "routine" | "turnTrace"
>;

const AI_OWNED_UNSUPPRESSED: ChatOwnershipAck = { state: "ai_owned", suppressed: false };

/**
 * Only a completed turn carries an envelope. A bootstrap greeting
 * (`startConversation`) has no user turn and no conversation yet.
 */
export const isChatTurnResponse = (response: AssistantChatResponse): response is ChatResponse =>
  typeof response.conversationId === "string" && typeof response.assistantMessageId === "string";

/**
 * Every turn producer records an assessment (`not_recorded` when none ran), so
 * this backstop only covers a source that predates that rule; it deliberately
 * carries no originating ids because it has none to report.
 */
const notRecordedAnswerCoverage = (): ChatAnswerCoverageAssessment => ({
  availability: "not_recorded",
  originatingTurnId: "",
  originatingRequestId: "",
});

export const buildAgentReplyEnvelope = (source: AgentReplyEnvelopeSource): AgentReplyEnvelopeCore => ({
  conversationId: source.conversationId,
  answerCoverage: source.answerCoverage ?? notRecordedAnswerCoverage(),
  ownership: source.ownership ?? AI_OWNED_UNSUPPRESSED,
  ...(source.routine ? { routine: source.routine } : {}),
  // The turn spine is the root trace of the turn: the id an operator sees in Activity.
  ...(source.turnTrace?.spine.traceId ? { traceId: source.turnTrace.spine.traceId } : {}),
});
