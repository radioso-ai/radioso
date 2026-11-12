import type { ChatRoutineProvider } from "../../contracts/routineProvider.js";
import type { PreparedSession } from "../chatSessionPreparer.js";

type RoutineTurnRequest = Parameters<ChatRoutineProvider["forTurn"]>[0];

/** What one routine attempt brings to the request beyond the session: its own ports and pins. */
type RoutineTurnAttempt = Pick<
  RoutineTurnRequest,
  | "modelGateway"
  | "accountId"
  | "pinnedRoutineIds"
  | "responseLanguage"
  | "groundedAnswerRenderer"
  | "throwIfCancelled"
  | "includeSlotValues"
>;

/**
 * The routine provider's request for a message turn: the agent, release, workspace and the
 * policies the prepared session carries, plus the ports this attempt brings. The pre-retrieval
 * routine attempt and the coverage reaction's attempt build their requests here, so both ask
 * for the same turn.
 */
export const routineTurnRequest = (
  session: PreparedSession,
  attempt: RoutineTurnAttempt,
): RoutineTurnRequest => ({
  modelGateway: attempt.modelGateway,
  agentId: session.agent.id,
  agentRevisionId: session.conversation.agentRevisionId ?? undefined,
  workspaceId: session.conversation.workspaceId,
  accountId: attempt.accountId,
  pinnedRoutineIds: attempt.pinnedRoutineIds,
  previewRoutineIds: session.previewRoutineIds,
  routineInvocation: session.routineInvocation,
  skillEffects: session.skillEffects,
  conversationDurability: session.conversationDurability,
  responseLanguage: attempt.responseLanguage,
  groundedAnswerRenderer: attempt.groundedAnswerRenderer,
  throwIfCancelled: attempt.throwIfCancelled,
  turnPlan: session.turnPlan,
  includeSlotValues: attempt.includeSlotValues,
});
