export type ChatAnswerFeedbackValue = "up" | "down";

export interface ChatAnswerFeedbackEntry {
  id: string;
  value: ChatAnswerFeedbackValue;
  comment: string | null;
  actorType: "authenticated_user" | "api_token" | "anonymous_user";
  actorId: string;
  accountId: string | null;
  userId: string | null;
  anonymousSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerFeedbackHistoryProviderPort {
  listByAssistantMessageIds(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<Map<string, ChatAnswerFeedbackEntry[]>>;
}

export class NoopAnswerFeedbackHistoryProvider implements AnswerFeedbackHistoryProviderPort {
  async listByAssistantMessageIds(): Promise<Map<string, ChatAnswerFeedbackEntry[]>> {
    return new Map();
  }
}
