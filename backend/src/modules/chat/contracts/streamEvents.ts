import type { ActivitySummary, ActivityTrace } from "../../retrieval/public.js";
import type { SkillDisplayMetadata } from "../../skills/public.js";
import type { AnswerSegment, ChatCitation } from "./answerTypes.js";
import type { ChatRoute, ChatSuggestion } from "../types/chatResponses.js";
import type { TurnTraceEnvelope } from "../services/turnTraceEnvelope.js";

export type SkillStreamPhase = "active" | "completed" | "failed";

export interface SkillStreamReceipt {
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
  | { type: "conversation"; conversationId: string }
  | { type: "chunk"; text: string }
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
      citations?: ChatCitation[];
      answerSegments?: AnswerSegment[];
      suggestions?: ChatSuggestion[];
      activitySummary: ActivitySummary;
      activityTrace: ActivityTrace;
      turnTrace?: TurnTraceEnvelope;
      route: ChatRoute;
      skill?: SkillStreamPayload;
    };
