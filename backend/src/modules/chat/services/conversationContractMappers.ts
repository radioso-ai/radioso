import type {
  ConversationAgentConfig,
  ConversationInputEvent,
  ConversationMessage,
  ConversationTrace,
  ConversationTraceStage,
  StagedContext,
} from "@radioso/conversation-contract";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { AgentRecord } from "../../agents/public.js";
import type { ActivityTrace, RetrievalPipelineResult } from "../../retrieval/public.js";

export const toConversationMessage = (message: MessageRecord): ConversationMessage => ({
  id: message.id,
  role: message.role,
  content: message.content,
  createdAt: message.createdAt.toISOString(),
  metadata: message.metadata,
});

export const toConversationMessages = (messages: MessageRecord[]): ConversationMessage[] =>
  messages.map(toConversationMessage);

export const toConversationInputEvent = (message: MessageRecord): ConversationInputEvent => ({
  id: message.id,
  kind: "message",
  content: message.content,
  metadata: message.inputMetadata ? { ...message.inputMetadata } : undefined,
});

export const toConversationAgentConfig = (agent: AgentRecord): ConversationAgentConfig => ({
  id: agent.id,
  name: agent.name,
  instructions: agent.customInstruction.trim() ? [agent.customInstruction] : [],
  defaultLocale: agent.assistantDefaultLocale,
  model: agent.chatModelOverride
    ? {
        provider: agent.chatModelOverride.provider,
        model: agent.chatModelOverride.model,
      }
    : null,
  metadata: {
    workspaceId: agent.workspaceId,
    retrievalEnabled: agent.retrievalEnabled,
    // Read by the contact routine activator to gate activation on the per-agent flag.
    contactRequestsEnabled: agent.contactRequestsEnabled,
  },
});

const fallbackConversationTrace = (): ConversationTrace => ({
  traceId: "unavailable-trace",
  startedAt: new Date().toISOString(),
  stages: [],
  links: [],
});

const toConversationTraceStage = (stage: ActivityTrace["stages"][number]): ConversationTraceStage => ({
  id: stage.stageId,
  kind: stage.kind,
  status: stage.status,
  startedAt: stage.startedAt,
  inputs: stage.inputs,
  outputs: stage.outputs,
  metrics: stage.metrics,
});

export const toConversationTrace = (trace: ActivityTrace | undefined): ConversationTrace => {
  if (!trace) {
    return fallbackConversationTrace();
  }
  return {
    traceId: trace.traceId,
    startedAt: trace.startedAt,
    completedAt: trace.completedAt,
    stages: trace.stages.map(toConversationTraceStage),
    links: trace.links.map((link) => ({
      from: link.fromStageId,
      to: link.toStageId,
      kind: link.kind,
    })),
    summary: trace.summary as Record<string, unknown> | undefined,
  };
};

// Stages the prepared session's retrieval result. `kind` describes the staged
// data shape (a retrieval pipeline result, skipped or not). `source` is the owning
// skill — a social or identity turn carries its own skill name here, never
// "retrieval.answer". `source` is optional because the preparer stages the result
// before a skill is selected (A1, issue #482); `buildPreparedTurnOutcome` stamps
// the dispatching skill name at dispatch time.
export const toPreparedStagedContext = (
  retrieval: RetrievalPipelineResult,
  source?: string,
): StagedContext => ({
  kind: "retrieval",
  ...(source !== undefined ? { source } : {}),
  data: retrieval,
  metadata: {
    contextCount: retrieval.contexts.length,
    retrievalSkipped: retrieval.diagnostics.retrievalSkipped ?? false,
  },
});
