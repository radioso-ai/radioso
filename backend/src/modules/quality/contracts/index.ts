import type { AssistantTurnOutcome } from "../../chat/contracts/index.js";

export type { AssistantTurnOutcome } from "../../chat/contracts/index.js";

export type QualityFeedbackValue = "up" | "down";

export interface QualityFeedbackSummary {
  upCount: number;
  downCount: number;
  comments: Array<{
    value: QualityFeedbackValue;
    comment: string;
    createdAt: string;
  }>;
}

export interface LowQualityTurn {
  assistantMessageId: string;
  conversationId: string;
  agentId: string | null;
  agentName: string | null;
  channel: string | null;
  question: string | null;
  answerPreview: string;
  answerOutcome: AssistantTurnOutcome | null;
  createdAt: string;
  feedback: QualityFeedbackSummary;
}

export interface ListLowQualityTurnsInput {
  outcomes?: AssistantTurnOutcome[];
  feedbackValues?: QualityFeedbackValue[];
  hasComment?: boolean;
  agentId?: string;
  channel?: string;
  from?: string;
  to?: string;
  offset?: number;
  limit: number;
}

export interface LowQualityTurnsPage {
  items: LowQualityTurn[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface QualityTurnsServicePort {
  listLowQualityTurns(workspaceId: string, input: ListLowQualityTurnsInput): Promise<LowQualityTurnsPage>;
}
