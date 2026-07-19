import type { MessageRecord } from "../src/db/repositories/messageRepository.js";
import type { InternalAgentConfig } from "../src/modules/agents/public.js";
import type {
  WorkbenchReplayInput,
  WorkbenchReplayResult,
  WorkbenchReplayRunner,
} from "../src/modules/chat/services/workbenchReplayRunner.js";
import type { EvalRunObservedOutput } from "../src/modules/eval/domain/types.js";
import type {
  ConversationQualityCase,
  ConversationQualityRunnerPort,
} from "../src/modules/eval/suite/index.js";

/**
 * Maps a WorkbenchReplayRunner result into the eval domain's observed-output shape that
 * the suite scorer understands. This is the single translation point between "how a turn
 * is produced" (chat) and "how a turn is scored" (eval), kept out of the pure suite core
 * so that core never depends on chat internals.
 */
export const observedOutputFromReplayResult = (
  result: WorkbenchReplayResult,
): EvalRunObservedOutput => ({
  retrievedChunks: result.resolvedConfig.retrievedChunks.map((chunk) => ({ ...chunk })),
  answer: result.answer,
  citations: result.citations,
  answerSegments: result.answerSegments,
  groundingSummary: result.groundingSummary,
  groundingVerdict: result.groundingSummary?.verdict,
  turnTrace: result.turnTrace,
});

export interface ReplayContext {
  workspaceId: string;
  agentId: string;
  accountId?: string | null;
  baselineAgentConfig: InternalAgentConfig;
}

/**
 * Turns a committed case into the runner's input: prior turns become replayed history
 * records and any seeded routine position is passed through so the agent resumes
 * mid-routine. The ephemeral conversation id is injected by the runner, so the history
 * records only need a stable placeholder.
 */
export const buildReplayInput = (
  evalCase: ConversationQualityCase,
  context: ReplayContext,
): WorkbenchReplayInput => {
  const history: MessageRecord[] = (evalCase.history ?? []).map((turn, index) => ({
    id: `cq-history-${index}`,
    conversationId: "cq-replay",
    workspaceId: context.workspaceId,
    role: turn.role,
    content: turn.content,
    createdAt: new Date(0),
  }));

  return {
    workspaceId: context.workspaceId,
    accountId: context.accountId ?? null,
    sourceAgentId: context.agentId,
    baselineAgentConfig: context.baselineAgentConfig,
    agentConfigOverride: evalCase.agentConfigOverride,
    query: evalCase.query,
    history,
    routineStartState: evalCase.routineStartState ?? null,
  };
};

/**
 * Adapts a composed WorkbenchReplayRunner into the suite's narrow runner port.
 */
export const createWorkbenchReplayRunnerPort = (
  runner: Pick<WorkbenchReplayRunner, "run">,
  context: ReplayContext,
): ConversationQualityRunnerPort => ({
  async run(evalCase) {
    const result = await runner.run(buildReplayInput(evalCase, context));
    return observedOutputFromReplayResult(result);
  },
});
