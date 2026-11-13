import type {
  Routine,
  RoutineItemSelection,
  RoutineState,
  RoutineStep,
  RoutineTraceStepEntry,
  TurnContext,
} from "@radioso/conversation-contract";
import { readableSlotValue } from "@radioso/conversation-contract";

import { checkSlotValue } from "./slotValue.js";

/** A pick the run took: the step that showed the card, the slot it filled, and the run's variables with it. */
interface PickedItem {
  stepId: string;
  slot: string;
  variables: Record<string, unknown>;
}

const itemSlotKeys = (routine: Routine): ReadonlySet<string> =>
  new Set((routine.slots ?? []).filter((slot) => slot.type === "item").map((slot) => slot.key));

/**
 * The visitor's pick of a card a routine step showed (#1763), written into the `item` slot that
 * step binds. It applies only while the run waits on that step and the step lets the visitor pick
 * into that slot; a pick from an older reply, another routine or a step that moved on is null, and
 * the turn reads the message as any reply. The host validated the card against the stored block;
 * the value is checked again here like every value that enters routine state.
 */
export const pickedItem = (
  routine: Routine,
  state: RoutineState,
  selection: RoutineItemSelection | undefined,
): PickedItem | null => {
  const stepId = state.path.at(-1) ?? routine.rootStepId;
  const step = routine.steps.find((candidate) => candidate.id === stepId);
  if (
    !selection ||
    !step ||
    selection.routineId !== routine.id ||
    selection.stepId !== step.id ||
    step.present?.selection !== "single" ||
    step.present.slot !== selection.slot ||
    !itemSlotKeys(routine).has(selection.slot)
  ) {
    return null;
  }
  const checked = checkSlotValue("item", selection.item);
  if (!checked.ok) {
    return null;
  }
  return { stepId, slot: selection.slot, variables: { ...state.variables, [selection.slot]: checked.value } };
};

/** The trace entry of a pick: the step that showed the card, and the slot key it filled (never the item). */
export const pickedItemTraceEntry = (picked: PickedItem | null): RoutineTraceStepEntry[] =>
  picked ? [{ stepId: picked.stepId, kind: "chat", event: "item_selected", capturedSlotKeys: [picked.slot] }] : [];

const comparable = (text: string): string => text.replace(/\s+/gu, " ").trim().toLowerCase();

/** The assistant's latest message on the turn: where the items a reply may name were listed. */
const latestAssistantText = (turn: TurnContext | undefined): string =>
  comparable([...(turn?.history ?? [])].reverse().find((message) => message.role === "assistant")?.content ?? "");

/**
 * Whether an item read from the visitor's text is one the assistant listed by name in its latest
 * message: the name a reply gives must appear there whole. A structural check of what was shown,
 * never of the visitor's words, so "the second one" after cards (whose titles are not in the text)
 * names nothing, while a home the reply listed in text can be named.
 */
const listedByName = (value: unknown, listed: string): boolean => {
  const name = readableSlotValue(value);
  return typeof name === "string" && comparable(name).length > 0 && listed.includes(comparable(name));
};

/**
 * The values without those for an `item` slot `step` does not bind. Only a pick, or the presenting
 * step's own reply naming an item its latest message listed, fills one: an opening message or a
 * reply to another step that names an item fills nothing. The same object when nothing is dropped.
 */
export const withoutUnboundItemSlots = (
  routine: Routine,
  values: Record<string, unknown>,
  step?: RoutineStep,
  turn?: TurnContext,
): Record<string, unknown> => {
  const items = itemSlotKeys(routine);
  const bound = step?.present?.slot;
  const kept = Object.entries(values).filter(([key, value]) =>
    !items.has(key) || (key === bound && listedByName(value, latestAssistantText(turn))));
  return kept.length === Object.keys(values).length ? values : Object.fromEntries(kept);
};
