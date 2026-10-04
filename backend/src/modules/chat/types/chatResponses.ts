import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import type { ActivitySummary, ActivityTrace } from "../../retrieval/public.js";
import type { SkillDisplayMetadata } from "../../skills/public.js";
import type { TurnTraceEnvelope } from "../services/turnTraceEnvelope.js";
import type {
  ChatAnswerCoverageAssessment,
  ChatAnswerCoverageInteractionTrace,
} from "../contracts/answerCoverage.js";
import type { ChatRoutineInvocationReport, ChatRoutineTurnState } from "../contracts/routineTurnState.js";

export type ChatSuggestionKind = string;

export type ChatSuggestionAction =
  | { kind: "ask_followup" }
  | {
      kind: "start_intent";
      intent: {
        skillName: string;
        intentName?: string;
        display?: SkillDisplayMetadata;
      };
    };

export interface ChatSuggestion {
  /**
   * Stable chip identity (spec 1150 FR-008). Optional: only authored exact-content
   * chips carry one today: generated follow-up suggestions have no durable identity
   * to key on.
   */
  id?: string;
  text: string;
  kind: ChatSuggestionKind;
  citation?: ChatCitation;
  action?: ChatSuggestionAction;
}

export interface ChatRoute {
  type: "direct" | "retrieval";
  reason: "assistant_identity" | "conversation_start" | "evidence_required" | "social_only";
}

export interface ChatOwnershipAck {
  state: "ai_owned" | "human_owned";
  suppressed: boolean;
}

export interface ChatResponse {
  conversationId: string;
  agentId?: string;
  agentName?: string;
  assistantMessageId: string;
  route: ChatRoute;
  answer: string;
  skillOutcome?: string;
  answerOutcome?: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  activitySummary: ActivitySummary;
  activityTrace: ActivityTrace;
  ownership?: ChatOwnershipAck;
  /** Where this turn left the routine it touched; absent when no routine ran. */
  routine?: ChatRoutineTurnState;
  /** What became of the tool call this turn carried; absent on a message turn. */
  invocation?: ChatRoutineInvocationReport;
  /**
   * Turn-trace envelope: conversation spine as the root span with capability
   * traces as typed leaves. Surfaced under `debug` (operator-only); the legacy
   * `activitySummary`/`activityTrace` fields above stay until the frontend and
   * read path consume the envelope, then drop.
   */
  turnTrace?: TurnTraceEnvelope;
  answerCoverage?: ChatAnswerCoverageAssessment;
  interactionTrace?: ChatAnswerCoverageInteractionTrace;
}

export type ChatBootstrapResponse = Omit<ChatResponse, "conversationId" | "assistantMessageId"> & {
  conversationId?: string;
  assistantMessageId?: string;
  bootstrapGreetingId?: string;
};
