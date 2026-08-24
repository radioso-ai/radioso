import type { UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import type { ModelCallUsageAttribution } from "../../../shared/domain/modelCallUsageContext.js";
import type { CopilotExpensiveOperationGuardDependencies } from "./expensiveOperation.js";
import type {
  AssistantClientContextCapabilities,
  AssistantPageContext,
} from "../../chat/contracts/index.js";

export interface CopilotAgentTurnProbeInput {
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

export interface CopilotAgentTurnProbeResult {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  agentId: string;
  answer: string;
  citations: ReadonlyArray<unknown>;
  skillOutcome?: string;
  answerOutcome?: string;
  activitySummary?: unknown;
  activityTrace?: unknown;
  turnTrace?: unknown;
}

export interface CopilotAgentTurnProbePort {
  testTurn(input: CopilotAgentTurnProbeInput): Promise<CopilotAgentTurnProbeResult>;
}

export interface AgentTurnProbeRunnerInput {
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

export interface AgentTurnProbeRunnerPort {
  run(input: AgentTurnProbeRunnerInput): Promise<CopilotAgentTurnProbeResult>;
}

export interface AgentTurnProbeConversationReader {
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<{
    workspaceId: string;
    agentId: string | null;
    sourceChannel: string | null;
    sourceOrigin: string | null;
  } | null>;
}

export interface AgentTurnProbeAgentReader {
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<unknown | null>;
}

export interface AgentTurnProbeRoutineReader {
  findById(agentId: string, routineId: string): Promise<{
    status: "draft" | "published" | "superseded" | "archived";
  } | null>;
}

export interface AgentTurnProbeServiceDependencies extends CopilotExpensiveOperationGuardDependencies {
  conversationReader: AgentTurnProbeConversationReader;
  agentReader: AgentTurnProbeAgentReader;
  routineReader: AgentTurnProbeRoutineReader;
  turnRunner: AgentTurnProbeRunnerPort;
}
