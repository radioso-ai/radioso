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

/** The minimum a step and an edge expose to decide where a presenting step's results come from. */
interface PresentSourceStep {
  stableStepId: string;
  kind: string;
}

interface PresentSourceEdge {
  fromStep: string;
  toRef: string;
}

/**
 * The tool steps whose result is still staged when the routine reaches `stepId` on the same turn:
 * those that reach it through tool and action steps only, in document order. A waiting step in
 * between, a message step or an approval, ends the turn and the staged result with it.
 */
export const presentSourceCandidates = (
  steps: readonly PresentSourceStep[],
  transitions: readonly PresentSourceEdge[],
  stepId: string,
): string[] => {
  const kindOf = new Map(steps.map((step) => [step.stableStepId, step.kind]));
  const tools = new Set<string>();
  const visited = new Set<string>();
  const pending = [stepId];
  while (pending.length > 0) {
    const target = pending.pop();
    for (const edge of transitions) {
      const kind = kindOf.get(edge.fromStep);
      if (edge.toRef !== target || visited.has(edge.fromStep) || (kind !== "tool" && kind !== "action")) {
        continue;
      }
      visited.add(edge.fromStep);
      pending.push(edge.fromStep);
      if (kind === "tool") {
        tools.add(edge.fromStep);
      }
    }
  }
  return steps.map((step) => step.stableStepId).filter((id) => tools.has(id));
};
