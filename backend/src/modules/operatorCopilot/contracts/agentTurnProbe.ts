import type { UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";
import type { ModelCallUsageAttribution } from "../../../shared/domain/modelCallUsageContext.js";
import type { CopilotExpensiveOperationGuardDependencies } from "./expensiveOperation.js";
import type {
  AssistantClientContextCapabilities,
  AssistantPageContext,
} from "../../chat/contracts/index.js";
import type { ProbeConversationReadPort } from "../../chat/contracts/index.js";
import type { ProbeRoutineReadPort } from "../../routines/public.js";

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

export interface AgentTurnProbeAgentReader {
  findAgentForProbe(agentId: string, workspaceId: string): Promise<unknown>;
}

export interface AgentTurnProbeServiceDependencies extends CopilotExpensiveOperationGuardDependencies {
  conversationReader: ProbeConversationReadPort;
  agentReader: AgentTurnProbeAgentReader;
  routineReader: ProbeRoutineReadPort;
  turnRunner: AgentTurnProbeRunnerPort;
}
