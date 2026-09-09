import { notFound } from "../../../shared/domain/errors.js";
import { PUBLIC_ASSISTANT_FALLBACK_NAME } from "../../../shared/domain/responseIdentity.js";
import { applyAgentRevisionSnapshot, materializeAgentFromConfig, type AgentRevision, type InternalAgentConfig } from "../../agents/public.js";
import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type {
  FrozenTestValue,
  TestExecutionHistoryEntry,
  TrustedTestExecutionRunnerPort,
} from "../../test-execution/public.js";
import type { ResolvedVariableInput } from "../../context-variables/public.js";
import {
  importTestExecutionReplayContinuation,
} from "./testExecutionContinuation.js";
import type { WorkbenchReplayRunner } from "./workbenchReplayRunner.js";
import type { ChatBootstrapService } from "./chatBootstrapService.js";

/** Live, non-versioned agent settings that remain subject to runtime authorization. */
interface TestExecutionLiveAgentConfigReaderPort {
  find(input: { workspaceId: string; agentId: string }): Promise<InternalAgentConfig | null>;
}

/** Re-reads the candidate under its workspace/agent ownership before every execution. */
interface TestExecutionCandidateRevisionReaderPort {
  findRevision(input: { workspaceId: string; agentId: string; revisionId: string }): Promise<AgentRevision | null>;
}

interface TrustedTestExecutionRunnerAdapterOptions {
  replay: Pick<WorkbenchReplayRunner, "run">;
  liveAgentConfig: TestExecutionLiveAgentConfigReaderPort;
  revisions: TestExecutionCandidateRevisionReaderPort;
  bootstrap?: Pick<ChatBootstrapService, "startConversation">;
}

const historyMessage = (entry: TestExecutionHistoryEntry, conversationId: string, workspaceId: string): MessageRecord => ({
  id: entry.messageId ?? `${entry.turnId}:${entry.role}:${entry.attemptId}`,
  conversationId,
  workspaceId,
  role: entry.role,
  content: entry.content,
  createdAt: entry.createdAt,
});

const sampleVariables = (values: readonly FrozenTestValue[], revision: AgentRevision): ResolvedVariableInput[] => values.map((value) => {
  const enablement = revision.snapshot.contextVariableEnablements.find(
    (candidate) => candidate.variableId === value.contextVariableId && candidate.enabled,
  );
  if (!enablement) throw new Error("test_execution_sample_not_enabled_in_candidate");
  return {
    name: value.name,
    description: value.description,
    value: value.value,
    surfacing: enablement.surfacing,
    sensitive: value.sensitive,
    trust: value.trust,
  };
});

/**
 * The sole bridge from private test-execution state into the chat engine. It has no
 * production conversation lookup and always selects the safe-test replay profile.
 */
export class TrustedTestExecutionRunnerAdapter implements TrustedTestExecutionRunnerPort {
  constructor(private readonly options: TrustedTestExecutionRunnerAdapterOptions) {}

  async bootstrap(input: {
    workspaceId: string;
    agentId: string;
    candidateRevision: AgentRevision;
    accountId: string | null;
  }): Promise<{ answer: string; messageId: string } | null> {
    if (!this.options.bootstrap) return null;
    const revision = await this.options.revisions.findRevision({
      workspaceId: input.workspaceId, agentId: input.agentId, revisionId: input.candidateRevision.id,
    });
    if (!revision) throw notFound("Agent revision is unavailable for test execution");
    const live = await this.options.liveAgentConfig.find({ workspaceId: input.workspaceId, agentId: input.agentId });
    if (!live) throw notFound("Agent configuration is unavailable for test execution");
    const resolvedAgent = applyAgentRevisionSnapshot(
      materializeAgentFromConfig(live, { agentId: input.agentId, workspaceId: input.workspaceId }),
      revision,
    );
    // Bootstrap needs a presentable identity. The operator title is useful when
    // present; otherwise use the shared neutral display fallback, never a
    // workspace name. This remains private to the immutable test prompt.
    const bootstrapName = resolvedAgent.name.trim()
      || resolvedAgent.internalName?.trim()
      || PUBLIC_ASSISTANT_FALLBACK_NAME;
    const agent = resolvedAgent.name === bootstrapName
      ? resolvedAgent
      : { ...resolvedAgent, name: bootstrapName };
    const greeting = await this.options.bootstrap.startConversation({
      workspaceId: input.workspaceId, agentId: input.agentId, accountId: input.accountId ?? undefined,
      sourceChannel: "authenticated_chat", agentOverride: agent, revisionId: revision.id,
    });
    return greeting ? { answer: greeting.answer, messageId: greeting.bootstrapGreetingId ?? `bootstrap:${revision.id}` } : null;
  }

  async run(input: Parameters<TrustedTestExecutionRunnerPort["run"]>[0]) {
    if (input.executionMode !== "safe_test") {
      throw new Error("test_execution_requires_safe_test");
    }
    const [agentConfig, revision] = await Promise.all([
      this.options.liveAgentConfig.find({ workspaceId: input.workspaceId, agentId: input.agentId }),
      this.options.revisions.findRevision({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        revisionId: input.candidateRevision.id,
      }),
    ]);
    if (!agentConfig) throw notFound("Agent is unavailable for test execution");
    if (!revision) throw notFound("Agent revision is unavailable for test execution");

    const continuation = importTestExecutionReplayContinuation(input.continuation, input.conversationId);
    const replayed = await this.options.replay.run({
      workspaceId: input.workspaceId,
      sourceAgentId: input.agentId,
      conversationId: input.conversationId,
      candidateRevision: revision,
      baselineAgentConfig: agentConfig,
      query: input.message,
      history: input.history.map((entry) => historyMessage(entry, input.conversationId, input.workspaceId)),
      routineStartState: continuation.routineState
        ? (() => {
            const { sessionId: _sessionId, ...state } = continuation.routineState;
            return state;
          })()
        : null,
      pendingClarificationStartState: continuation.pendingClarification
        ? (() => {
            const { sessionId: _sessionId, ...pending } = continuation.pendingClarification;
            return pending;
          })()
        : null,
      directiveStateStartState: continuation.directiveState,
      preResolvedHostVariables: sampleVariables(input.testValues, revision),
      executionMode: "safe_test",
    });
    if (!replayed.continuation) {
      throw new Error("test_execution_continuation_missing");
    }
    if (!replayed.messageId) {
      throw new Error("test_execution_message_id_missing");
    }
    return {
      answer: replayed.answer,
      messageId: replayed.messageId,
      continuation: replayed.continuation,
    };
  }
}
