import type { ActivitySummary, ActivityTrace } from "../../retrieval/public.js";
import type { AnswerSegment, ChatCitation } from "./answerTypes.js";
import type { ChatRoute, ChatSuggestion } from "../types/chatResponses.js";
import type { ChatIntakeReceipt } from "../services/chatIntakeProvider.js";

export type SkillStreamPhase = "active" | "completed" | "failed";

export interface SkillStreamPayload {
  skillName: string;
  phase: SkillStreamPhase;
  localizedTitle?: string;
  receipt?: ChatIntakeReceipt;
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
      route: ChatRoute;
      skill?: SkillStreamPayload;
    };
