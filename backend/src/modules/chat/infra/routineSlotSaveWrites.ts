import type { AuditEventInput } from "../../audit/contracts/index.js";
import {
  routineValueWriter,
  type ContextValueSaver,
  type ConversationSaveScope,
} from "../../context-variables/public.js";
import type { RoutineSlotSaveScope } from "../../routines/public.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { SameType } from "../../../shared/types/sameType.js";
import type { AssistantTurnPersistencePort } from "../services/chatTurnLifecycle.js";
import { withRoutineSaveTrace } from "../services/routines/routineSaveTrace.js";

type CompleteAssistantTurnInput = Parameters<AssistantTurnPersistencePort["completeAssistantTurn"]>[0];

// A slot names the scopes a save for a conversation has: one added on either side fails tsc here.
const saveScopesAgree: SameType<RoutineSlotSaveScope, ConversationSaveScope> = true;
void saveScopesAgree;

/**
 * Saves the slot values the turn's ending routine saves to attributes (#1884), in the turn's
 * transaction beside `routine.completed`, so they and their change events commit with the turn or
 * not at all. A person save goes to the conversation's verified customer. Returns the turn's audit
 * event with what each save did on the routine's trace; the event as it was when nothing is saved.
 */
export const saveRoutineSlotValues = async (
  db: Db,
  saver: ContextValueSaver | undefined,
  input: CompleteAssistantTurnInput,
): Promise<AuditEventInput> => {
  const transition = input.routineStateTransition;
  if (!saver || transition?.kind !== "save" || !transition.slotSaves?.length) return input.auditEvent;
  const { routineId, executionId } = transition.state;
  const outcomes = await saver.saveAll(db, {
    workspaceId: input.workspaceId,
    conversation: { id: input.conversationId, verifiedCustomerId: input.verifiedCustomerId ?? null },
    writtenBy: routineValueWriter(routineId, executionId ?? null),
    routineId,
    saves: transition.slotSaves.map((save) => ({
      variableName: save.contextVariable,
      scope: save.scope,
      data: save.value,
      sensitive: save.sensitive,
    })),
  });
  return withRoutineSaveTrace(input.auditEvent, routineId, transition.slotSaves.map((save, index) => ({
    slotKey: save.slotKey,
    contextVariable: save.contextVariable,
    scope: save.scope,
    outcome: outcomes[index],
  })));
};
