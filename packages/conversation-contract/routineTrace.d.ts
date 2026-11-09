// The record of one routine turn's walk over its graph, surfaced to the debug panel.
import type {
  REDACTED_VALUE,
  RoutineSlotType,
  RoutineStep,
  RoutineTerminalKind,
} from "./index.js";

/**
 * Why a next-step selector's completion could not be read as a decision. Structural
 * parsing failures only, never a judgment about the visitor's message.
 */
export type RoutineUnreadableReason = "no_json_object" | "invalid_json" | "missing_required_fields";

/**
 * The next-step selector's own reading of one turn, recorded on the routine trace so
 * an operator can tell "the model returned nothing" from "the model returned a value
 * that was not captured". Slot keys and counts only, never values.
 */
export interface RoutineSelectionTrace {
  /**
   * - `transition`: the model chose one of the step's conditions.
   * - `stay`: the model chose none, so the step is not yet satisfied.
   * - `off_topic`: the model chose none and read the message as a different request.
   * - `unreadable`: the model's output could not be parsed or lacked the `claimsAuthority`
   *   flag, so no exit was chosen; any values come from the `slotFallback` reading.
   * - `authority_claim`: the model flagged text posing as a system, operator, or assistant
   *   message, or claiming the request is already confirmed; the decision carries `hold`,
   *   so a chat step takes no exit and is asked again, whatever condition the model chose.
   */
  outcome: "transition" | "stay" | "off_topic" | "unreadable" | "authority_claim";
  /** Slot keys the model returned a value for, including a value that replaces a filled slot. */
  returnedSlotKeys: string[];
  /** Keys the model returned that the routine does not declare; they are dropped, never captured. */
  undeclaredKeyCount?: number;
  /** Set when `outcome` is `unreadable`: why the final decision completion could not be read. */
  unreadableReason?: RoutineUnreadableReason;
  /** Set when the selector retried after its first completion came back unreadable, whether or not the retry recovered. */
  retried?: true;
  /**
   * Set when the retry came back unreadable too on a step that collects slots, so the selector
   * read the message once more for slot values only: `read` when that completion could be read
   * (its values are `returnedSlotKeys`), `authority_claim` when it read text posing as a system
   * notice (no values kept, the step held), `unreadable` when it could not be read.
   */
  slotFallback?: "read" | "authority_claim" | "unreadable";
}

/**
 * What happened to one step as the runner walked the graph this turn. A debug-only
 * record: it carries slot *keys*, never captured *values* (which may be PII).
 */
export interface RoutineTraceStepEntry {
  stepId: string;
  kind: RoutineStep["kind"];
  /**
   * - `resumed`: the step the turn started on.
   * - `advanced`: moved onto this step from the previous one.
   * - `reasked`: stayed on the step because it isn't satisfied yet (a re-ask). On the routine's
   *   first turn the step was never asked, so staying on it is `rendered` instead.
   * - `fast_forwarded`: a satisfied slot-collection step skipped without re-asking.
   * - `skill_dispatched`: a skill (tool) step ran.
   * - `action_emitted`: an action step emitted a fire-and-forget request.
   * - `rendered`: the step whose reply the turn rendered.
   * - `reask_limit_reached`: the step was asked again more times in a row than the re-ask
   *   limit allows, so its reply was told to ask differently. The routine stays on the step.
   * - `reask_limit_handoff`: the step was still not answered on the turn after it asked
   *   differently, and the routine has a hand-off end, so the run ended `stuck` on this step
   *   and the conversation goes to a person (#1384).
   */
  event:
    | "resumed"
    | "advanced"
    | "reasked"
    | "fast_forwarded"
    | "skill_dispatched"
    | "action_emitted"
    | "rendered"
    | "suspended"
    | "decision_notified"
    | "decision_applied"
    | "reask_limit_reached"
    | "reask_limit_handoff";
  /** Declared slot keys captured at this step this turn (names only — never values). */
  capturedSlotKeys?: string[];
  /** Declared slot keys that held a value and were given a different one at this step this turn (names only — never values). */
  replacedSlotKeys?: string[];
  /** Declared slots whose returned value was not stored because it does not fit the slot's type (keys only). */
  rejectedSlots?: RoutineTraceRejectedSlot[];
  /** On `reask_limit_reached` and `reask_limit_handoff`: how many times in a row the step has now been asked again. */
  reaskCount?: number;
  /** Whether the LLM next-step selector ran for this step's edges. */
  viaSelector?: boolean;
  /** What the selector's model returned for this step's edges, when it ran and reported. */
  selection?: RoutineSelectionTrace;
  skillName?: string;
  skillStatus?: string;
  /** Host-private failure reason for a failed skill dispatch (e.g. mcp_timeout, suppressed_for_safe_test). */
  skillReason?: string;
  /** On the routine's first turn, this step read the opening message before it was asked (#1370). */
  readOpeningMessage?: boolean;
}

/**
 * A value the runner did not store (#1374, #1388). Key and reason only — never the value,
 * which may be personal data or an injection attempt.
 * - `not_scalar`: an object or array, which fits no slot type.
 * - `type_mismatch`: a scalar that does not fit the slot's declared type (an email that is
 *   not shaped like one, a date that is not a `YYYY-MM-DD` calendar date).
 * - `undeclared`: the key names no slot the routine declares. Reported only on a routine
 *   that declares a slot schema — one with none keeps every key, as it always has.
 */
export interface RoutineTraceRejectedSlot {
  key: string;
  reason: "not_scalar" | "type_mismatch" | "undeclared";
}

/**
 * One declared slot's value in a {@link RoutineRunTrace}, self-describing by the slot's
 * declared type. A concrete {@link ConversationRoutineRunner} produces this only when the
 * caller that constructed it opted in (e.g. the engine's own `DefaultRoutineRunner` takes
 * an `includeSlotValues` construction option) — a live customer conversation never opts
 * in, so a value never reaches that trace in the first place.
 */
export interface RoutineTraceSlotValue {
  key: string;
  type: RoutineSlotType;
  /** A sensitive slot's value reads as {@link REDACTED_VALUE}. */
  value: string | number | boolean;
  /** True when `value` was cut to the per-value bound; the stored value ends in "…". */
  truncated?: boolean;
}

/**
 * A step-by-step record of one routine turn's traversal, surfaced to the debug panel
 * as a {@link CapabilitySubTrace} (`namespace: "routine"`). Per-step entries carry slot
 * *keys* only, never values. `slotValues` is present only when the caller that resumed
 * the routine asked for it — see {@link RoutineTraceSlotValue} — which is how a private
 * test surface can show them while an ordinary trace never carries one at all.
 */
export interface RoutineRunTrace {
  routineId: string;
  /** Step the turn resumed on. */
  startStepId: string;
  /** Step the turn ultimately rendered; on a `stuck` ending, the step the routine was stuck on. */
  landedStepId: string;
  terminalKind?: RoutineTerminalKind;
  /** Declared slot keys newly captured this turn (names only). */
  capturedSlotKeys: string[];
  /**
   * Declared slot keys that held a value before this turn and were given a different one
   * (names only); absent when the turn replaced none. A key captured this turn is not listed.
   */
  replacedSlotKeys?: string[];
  /** Declared slot keys filled after this turn (names only). */
  filledSlotKeys: string[];
  /**
   * Every filled declared slot's value after this turn, in the routine's declared order,
   * capped to a bounded count — present only when the caller opted in.
   */
  slotValues?: RoutineTraceSlotValue[];
  /** Present alongside `slotValues` when the filled-slot count exceeded the bound. */
  omittedSlotCount?: number;
  steps: RoutineTraceStepEntry[];
}
