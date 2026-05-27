import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import type { ActivitySummary, ActivityTrace } from "../../retrieval/public.js";
import type { SkillDisplayMetadata } from "../../skills/public.js";

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
  text: string;
  kind: ChatSuggestionKind;
  citation?: ChatCitation;
  action?: ChatSuggestionAction;
}

export interface ChatRoute {
  type: "direct" | "retrieval";
  reason: "assistant_identity" | "conversation_start" | "evidence_required" | "social_only";
}

export interface ChatResponse {
  conversationId: string;
  agentId?: string;
  agentName?: string;
  assistantMessageId: string;
  route: ChatRoute;
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  activitySummary: ActivitySummary;
  activityTrace: ActivityTrace;
}

export type ChatBootstrapResponse = Omit<ChatResponse, "conversationId" | "assistantMessageId"> & {
  conversationId?: string;
  assistantMessageId?: string;
};
