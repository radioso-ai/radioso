import { z } from "zod";

/**
 * A chat step that shows a tool step's results as cards (#1763). The author binds where the cards
 * come from and where a pick goes; the model chooses which records show and which of their fields
 * fill a card. Structure is strict here. How the binding relates to the rest of the routine (the
 * source is an earlier tool step, the slot is an `item` slot, a slot means the visitor picks) is
 * reported by routine validation, so a half-made binding still saves as a draft.
 */

/** `single` lets the visitor pick one card; `none` only shows them. */
export const routineStepPresentSelections = ["none", "single"] as const;

const stableIdPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const slotKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const ROUTINE_PRESENT_LIMITS = {
  stableId: 120,
  slotKey: 120,
} as const;

export const routineStepPresentSchema = z.object({
  /** The tool step whose results the cards are drawn from. */
  from: z.string().trim().min(1).max(ROUTINE_PRESENT_LIMITS.stableId).regex(stableIdPattern),
  selection: z.enum(routineStepPresentSelections),
  /** The `item` slot the visitor's pick fills. */
  slot: z.string().trim().min(1).max(ROUTINE_PRESENT_LIMITS.slotKey).regex(slotKeyPattern).optional(),
}).strict();

export type RoutineStepPresent = z.infer<typeof routineStepPresentSchema>;

/** The binding a step's metadata declares, or null when it declares none or one that does not parse. */
export const presentBindingOf = (step: { metadata?: unknown }): RoutineStepPresent | null => {
  const metadata = step.metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const parsed = routineStepPresentSchema.safeParse((metadata as { present?: unknown }).present);
  return parsed.success ? parsed.data : null;
};
