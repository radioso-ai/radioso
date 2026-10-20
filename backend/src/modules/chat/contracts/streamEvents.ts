import type { ActivitySummary, ActivityTrace } from "../../retrieval/public.js";
import type { SkillDisplayMetadata } from "../../skills/public.js";
import type { AnswerSegment, ChatCitation } from "./answerTypes.js";
import type { ChatOwnershipAck, ChatRoute, ChatSuggestion, ChatTurnHandoff } from "../types/chatResponses.js";
import type { TurnTraceEnvelope } from "../services/turnTraceEnvelope.js";
import type { ConversationTurnStage } from "./interruption.js";
import type {
  ChatAnswerCoverageAssessment,
  ChatAnswerCoverageInteractionTrace,
} from "./answerCoverage.js";
import type { ChatRoutineInvocationReport, ChatRoutineTurnState } from "./routineTurnState.js";

type SkillStreamPhase = "active" | "completed" | "failed";
export type ChatStatusStage = "interpreting" | "searching" | "composing";

interface SkillStreamReceipt {
  fields: Array<{
    name: string;
    displayName: string;
    value: string;
  }>;
  statusLabel?: string;
}

export interface SkillStreamPayload {
  skillName: string;
  phase: SkillStreamPhase;
  display?: SkillDisplayMetadata;
  localizedTitle?: string;
  receipt?: SkillStreamReceipt;
}

export type ChatStreamEvent =
  | { type: "status"; stage: ChatStatusStage }
  | { type: "conversation"; conversationId: string }
  /**
   * The turn has read the language it answers in, before the answer's first chunk: `tag` is that
   * language's BCP 47 tag (`it`, `pt-BR`) when the turn's plan gives one, and absent when the
   * language came from elsewhere or carries no tag. At most one per turn, and none on a turn that
   * never reads a language (a teammate owns the conversation). Only on a turn whose request asks
   * for it (`reportResponseLanguage`), for a channel that acts on the language before the answer
   * (voice); the HTTP stream presenters drop it.
   */
  | { type: "language"; tag?: string }
  | { type: "chunk"; text: string }
  | {
      type: "cancelled";
      conversationId: string;
      reason: "superseded";
      stage: ConversationTurnStage;
      /**
       * The reply the turn keeps: the part of it that reached the listener, stored cut short
       * (`partial`), or the whole reply, stored before the cut.
       */
      storedReply?: { assistantMessageId: string; partial: boolean };
    }
  | {
      type: "suggestions";
      conversationId: string;
      suggestions: ChatSuggestion[];
    }
  | ({
      type: "skill";
      conversationId: string;
    } & SkillStreamPayload)
  | {
      type: "done";
      conversationId: string;
      agentId?: string;
      agentName?: string;
      assistantMessageId: string;
      answer: string;
      skillOutcome?: string;
      citations?: ChatCitation[];
      answerSegments?: AnswerSegment[];
      suggestions?: ChatSuggestion[];
      activitySummary: ActivitySummary;
      activityTrace: ActivityTrace;
      ownership?: ChatOwnershipAck;
      handoff?: ChatTurnHandoff;
      routine?: ChatRoutineTurnState;
      invocation?: ChatRoutineInvocationReport;
      turnTrace?: TurnTraceEnvelope;
      answerCoverage?: ChatAnswerCoverageAssessment;
      interactionTrace?: ChatAnswerCoverageInteractionTrace;
      route: ChatRoute;
      skill?: SkillStreamPayload;
    };
