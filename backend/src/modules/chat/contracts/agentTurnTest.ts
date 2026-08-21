import type { UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import type { ModelCallUsageAttribution } from "../../../shared/domain/modelCallUsageContext.js";
import type { AbuseControlPort } from "../../security/contracts/abuseControl.js";
import type {
  AssistantClientContextCapabilities,
  AssistantPageContext,
} from "../types/assistantApi.js";
import type { ChatResponse } from "../types/chatResponses.js";

export interface AgentTurnTestInput {
  workspaceId: string;
  accountId: string;
  operatorUserId: string;
  copilotConversationId: string;
  agentId: string;
  message: string;
  conversationId?: string;
  previewRoutineIds?: string[];
  userExpectedLocale?: string | null;
  inputMetadata?: UserMessageInputMetadata;
  pageContext?: AssistantPageContext | null;
  clientContextCapabilities?: AssistantClientContextCapabilities;
}

export interface AgentTurnTestResult extends Pick<
  ChatResponse,
  | "conversationId"
  | "assistantMessageId"
  | "agentId"
  | "answer"
  | "citations"
  | "skillOutcome"
  | "answerOutcome"
  | "activitySummary"
  | "activityTrace"
  | "turnTrace"
> {
  userMessageId: string;
}

/** Native chat-side port. Operator-copilot can satisfy its consumer contract structurally. */
export interface AgentTurnTestPort {
  testTurn(input: AgentTurnTestInput): Promise<AgentTurnTestResult>;
}

export interface AgentTurnTestRunnerInput {
  workspaceId: string;
  accountId: string;
  agentId: string;
  conversationId?: string;
  query: string;
  userExpectedLocale?: string | null;
  inputMetadata?: UserMessageInputMetadata;
  pageContext?: AssistantPageContext | null;
  clientContextCapabilities?: AssistantClientContextCapabilities;
  previewRoutineIds?: string[];
  sourceChannel: string;
  sourceOrigin: string;
  usageAttribution: ModelCallUsageAttribution;
}

export interface AgentTurnTestRunnerPort {
  run(input: AgentTurnTestRunnerInput): Promise<ChatResponse>;
}

export interface AgentTurnTestConversationReader {
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<{
    workspaceId: string;
    agentId: string | null;
    sourceChannel: string | null;
    sourceOrigin: string | null;
  } | null>;
}

export interface AgentTurnTestAgentReader {
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<unknown | null>;
}

export interface AgentTurnTestRoutineReader {
  findById(agentId: string, routineId: string): Promise<{
    status: "draft" | "published" | "superseded" | "archived";
  } | null>;
}

export interface AgentTurnTestMessageReader {
  findByIdAndWorkspaceId(workspaceId: string, messageId: string): Promise<{
    id: string;
    role: "user" | "assistant" | "system";
    metadata?: Record<string, unknown>;
  } | null>;
}

export interface AgentTurnTestServiceDependencies {
  conversationReader: AgentTurnTestConversationReader;
  agentReader: AgentTurnTestAgentReader;
  routineReader: AgentTurnTestRoutineReader;
  messageReader: AgentTurnTestMessageReader;
  abuseControl: AbuseControlPort;
  audit: {
    record(input: {
      accountId?: string | null;
      workspaceId?: string | null;
      eventType: string;
      eventStatus: string;
      metadata?: Record<string, unknown>;
    }): Promise<unknown>;
  };
  abusePolicy: { limit: number; windowMs: number };
  turnRunner: AgentTurnTestRunnerPort;
}
