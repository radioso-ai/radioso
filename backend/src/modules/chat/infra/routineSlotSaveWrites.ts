import type { AuditEventInput } from "../../audit/contracts/index.js";
import {
  routineValueWriter,
  type ContextValueSaver,
  type ConversationSaveScope,
} from "../../context-variables/public.js";
import type { RoutineSlotSaveScope } from "../../routines/public.js";
import { RoutineConsentRepository } from "../../../db/repositories/routineConsentRepository.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { SameType } from "../../../shared/types/sameType.js";
import type { AssistantTurnPersistencePort } from "../services/chatTurnLifecycle.js";
import type { CapturedRoutineTransition } from "../services/routines/deferredRoutineStore.js";
import { withRoutineSaveTrace } from "../services/routines/routineSaveTrace.js";

type CompleteAssistantTurnInput = Parameters<AssistantTurnPersistencePort["completeAssistantTurn"]>[0];

// A slot names the scopes a save for a conversation has: one added on either side fails tsc here.
const saveScopesAgree: SameType<RoutineSlotSaveScope, ConversationSaveScope> = true;
void saveScopesAgree;

/**
 * The writer reference of the values the turn's ending routine run saves, the one its consent
 * withdrawal matches; null when the turn saves no routine state.
 */
export const turnRoutineValueWriterRef = (transition: CapturedRoutineTransition | null | undefined, conversationId: string): string | null =>
  transition?.kind === "save" ? routineValueWriter(transition.state.routineId, transition.state.executionId ?? null, conversationId).ref : null;

/**
 * Saves the slot values the turn's ending routine saves to attributes (#1884), in the turn's
 * transaction beside `routine.completed`, so they and their change events commit with the turn or
 * not at all. A routine whose consent was withdrawn in this conversation saves nothing
 * (`withdrawn`): the withdrawal took every value the routine saved here, and a run that goes on
 * after it adds none. The turn has already locked the routine state a withdrawal erases, so one it
 * did not see waits for this turn and then takes what it saved. Returns the turn's audit event with
 * what each save did on the routine's trace; the event as it was when nothing is saved.
 */
export const saveRoutineSlotValues = async (
  db: Db,
  saver: ContextValueSaver | undefined,
  input: CompleteAssistantTurnInput,
): Promise<AuditEventInput> => {
  const transition = input.routineStateTransition;
  if (!saver || transition?.kind !== "save" || !transition.slotSaves?.length) return input.auditEvent;
  const { routineId, executionId } = transition.state;
  const withdrawn = await new RoutineConsentRepository(db).withdrawnInConversation({ conversationId: input.conversationId });
  const outcomes = withdrawn.some((record) => record.routineId === routineId)
    ? transition.slotSaves.map(() => "withdrawn" as const)
    : await saver.saveAll(db, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      writtenBy: routineValueWriter(routineId, executionId ?? null, input.conversationId),
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
