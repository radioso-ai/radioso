import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ActivitySummary, ActivityTrace } from "../../retrieval/public.js";
import type { SkillTurnStatus } from "./assistantTurnOutcomeTypes.js";

export type ChatIntakeStatus = SkillTurnStatus;

export interface ChatIntakeReceiptField {
  name: string;
  displayName: string;
  value: string;
}

export interface ChatIntakeReceipt {
  fields: ChatIntakeReceiptField[];
  statusLabel?: string;
}

export interface ChatIntakeResult {
  skillName: string;
  status: ChatIntakeStatus;
  skillOutcome?: string;
  stateId?: string;
  answer: string;
  activitySummary: ActivitySummary;
  activityTrace: ActivityTrace;
  receipt?: ChatIntakeReceipt;
}

export interface PublicChatIntakeAction {
  skillName: string;
  intentName: string;
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
    inputMetadata?: MessageRecord["inputMetadata"];
  }): Promise<ChatIntakeResult | null>;
  getPublicIntakeActions?(input: {
    workspaceId: string;
    agentId?: string | null;
    sourceChannel?: string | null;
  }): Promise<PublicChatIntakeAction[]>;
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

  async getPublicIntakeActions(input: Parameters<NonNullable<ChatIntakeProviderPort["getPublicIntakeActions"]>>[0]): Promise<PublicChatIntakeAction[]> {
    const actions = await Promise.all(
      this.providers.map((provider) => provider.getPublicIntakeActions?.(input) ?? Promise.resolve([])),
    );
    const seen = new Set<string>();
    return actions.flat().filter((action) => {
      const key = `${action.skillName}:${action.intentName}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}
