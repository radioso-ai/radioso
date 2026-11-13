import type {
  Routine,
  RoutineItemValue,
  RoutineShownItems,
  RoutineState,
  RoutineStep,
  RoutineTraceStepEntry,
  TurnContext,
} from "@radioso/conversation-contract";

import { checkSlotValue } from "./slotValue.js";

/** A pick the run took: the step that showed the card, the slot it filled, and the run's variables with it. */
interface PickedItem {
  stepId: string;
  slot: string;
  variables: Record<string, unknown>;
}

/** Why a routine pick filled nothing. Bounded: each is a metric label. */
type RoutineItemPickIgnoredReason = "other_routine" | "other_step" | "not_latest" | "consent" | "invalid";

/** What a routine pick did on a turn, reported with ids only. */
export interface RoutineItemPickEvent {
  routineId: string;
  stepId: string;
  outcome: "applied" | "ignored";
  reason?: RoutineItemPickIgnoredReason;
}

/** Notified of each routine pick a turn carries. Observational: what it throws is swallowed. */
export type RoutineItemPickObserver = (event: RoutineItemPickEvent) => void;

/** A turn's routine pick: applied, with the variables it fills, or ignored. */
type RoutinePick = { applied: PickedItem } | { applied: null };

const itemSlotKeys = (routine: Routine): ReadonlySet<string> =>
  new Set((routine.slots ?? []).filter((slot) => slot.type === "item").map((slot) => slot.key));

const sameRun = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined || right === undefined || left === right;

/**
 * The items `step` showed on its latest presentation in this run, from the turn: none when the
 * latest presentation the host found belongs to another routine, run or step.
 */
const shownBy = (routine: Routine, state: RoutineState, step: RoutineStep | undefined, turn: TurnContext): RoutineShownItems | null => {
  const shown = turn.inputEvent.shownItems;
  return shown && step && shown.routineId === routine.id && shown.stepId === step.id && sameRun(shown.executionId, state.executionId)
    ? shown
    : null;
};

const pickIgnoredReason = (
  routine: Routine,
  state: RoutineState,
  step: RoutineStep | undefined,
  turn: TurnContext,
  covered: ReadonlySet<string>,
): RoutineItemPickIgnoredReason | null => {
  const selection = turn.inputEvent.itemSelection!;
  if (selection.routineId !== routine.id || !sameRun(selection.executionId, state.executionId)) return "other_routine";
  if (!step || selection.stepId !== step.id || step.present?.selection !== "single" || step.present.slot !== selection.slot) return "other_step";
  if (shownBy(routine, state, step, turn)?.messageId !== selection.messageId) return "not_latest";
  if (covered.has(selection.slot)) return "consent";
  return itemSlotKeys(routine).has(selection.slot) ? null : "invalid";
};

/**
 * The visitor's pick of a card a routine step showed (#1763), written into the `item` slot that
 * step binds. It applies only while this run waits on that step, the card came from the step's
 * latest presentation, and no consent holds the slot back (`covered`: the slots a consent blocks or
 * waives this turn). Any other routine pick is ignored, and either way the turn's message, the
 * card's title, states nothing else. Null when the turn carries no routine pick. The host
 * validated the card against the stored block; the value is checked again like every value.
 */
export const routinePick = (
  routine: Routine,
  state: RoutineState,
  turn: TurnContext,
  covered: ReadonlySet<string>,
  observe?: RoutineItemPickObserver,
): RoutinePick | null => {
  const selection = turn.inputEvent.itemSelection;
  if (!selection) {
    return null;
  }
  const step = routine.steps.find((candidate) => candidate.id === (state.path.at(-1) ?? routine.rootStepId));
  const checked = checkSlotValue("item", selection.item);
  const reason = pickIgnoredReason(routine, state, step, turn, covered) ?? (checked.ok ? null : "invalid");
  try {
    observe?.({ routineId: routine.id, stepId: selection.stepId, outcome: reason ? "ignored" : "applied", ...(reason ? { reason } : {}) });
  } catch {
    // Observational only.
  }
  if (reason || !checked.ok) {
    return { applied: null };
  }
  return { applied: { stepId: selection.stepId, slot: selection.slot, variables: { ...state.variables, [selection.slot]: checked.value } } };
};

/** The trace entry of a pick: the step that showed the card, and the slot key it filled (never the item). */
export const pickedItemTraceEntry = (pick: RoutinePick | null): RoutineTraceStepEntry[] =>
  pick?.applied ? [{ stepId: pick.applied.stepId, kind: "chat", event: "item_selected", capturedSlotKeys: [pick.applied.slot] }] : [];

const comparable = (text: string): string => text.replace(/\s+/gu, " ").trim().toLowerCase();

/**
 * The shown item a typed answer names: by its position as shown (a number, or digits), its key, or
 * its exact title. Structural matching on what was shown, never on the visitor's words.
 */
const shownItemNamed = (value: unknown, shown: RoutineShownItems): RoutineItemValue | undefined => {
  const position = typeof value === "number" ? value : typeof value === "string" && /^\d{1,2}$/u.test(value.trim()) ? Number(value) : NaN;
  if (Number.isInteger(position)) {
    return shown.items[position - 1];
  }
  if (typeof value !== "string" || comparable(value).length === 0) {
    return undefined;
  }
  return shown.items.find((item) => item.key === value) ?? shown.items.find((item) => comparable(item.title) === comparable(value));
};

/**
 * The values with each `item` slot resolved to a stored item, or dropped. Only the presenting
 * step's own reply names an item, and only one its latest presentation showed: the value is then
 * that stored item, exactly as a pick would write it. An item the selector wrote itself, a name
 * nothing showed, an opening message and a reply to another step fill nothing. The same object
 * when nothing changes.
 */
export const resolveItemSlots = (
  routine: Routine,
  values: Record<string, unknown>,
  state: RoutineState,
  turn: TurnContext,
  step?: RoutineStep,
): Record<string, unknown> => {
  const items = itemSlotKeys(routine);
  const keys = Object.keys(values);
  if (!keys.some((key) => items.has(key))) {
    return values;
  }
  const shown = shownBy(routine, state, step, turn);
  const bound = step?.present?.slot;
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
    if (!items.has(key)) return [[key, value]];
    const named = key === bound && shown ? shownItemNamed(value, shown) : undefined;
    return named ? [[key, named]] : [];
  }));
};
