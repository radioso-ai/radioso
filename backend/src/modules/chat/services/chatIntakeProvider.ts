import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ActivitySummary, ActivityTrace } from "../../retrieval/public.js";

export type ChatIntakeStatus =
  | "active"
  | "paused"
  | "awaiting_confirmation"
  | "awaiting_tool"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export interface ChatIntakeResult {
  skillName: string;
  status: ChatIntakeStatus;
  stateId?: string;
  answer: string;
  activitySummary: ActivitySummary;
  activityTrace: ActivityTrace;
}

export interface ChatIntakeProviderPort {
  handle(input: {
    workspaceId: string;
    accountId?: string | null;
    agentId?: string | null;
    conversationId: string;
    userMessageId: string;
    query: string;
    history: MessageRecord[];
    sourceChannel?: string | null;
    sourceOrigin?: string | null;
    anonymousSessionId?: string | null;
    userExpectedLocale?: string | null;
  }): Promise<ChatIntakeResult | null>;
}

export class NoopChatIntakeProvider implements ChatIntakeProviderPort {
  async handle(): Promise<ChatIntakeResult | null> {
    return null;
  }
}

export class ChainedChatIntakeProvider implements ChatIntakeProviderPort {
  constructor(private readonly providers: ChatIntakeProviderPort[]) {}

  async handle(input: Parameters<ChatIntakeProviderPort["handle"]>[0]): Promise<ChatIntakeResult | null> {
    for (const provider of this.providers) {
      const result = await provider.handle(input);
      if (result) {
        return result;
      }
    }

    return null;
  }
}
