// The authored graph a routine runs: its steps, the transitions and guards between them, the
// slots it collects, and the kinds of ending a run can reach.
import type { AnswerCoverageCriteria, RoutineSkillOutcomeStatus, ValueSensitivity } from "./index.js";
import type { RoutineConsent } from "./routineConsent.js";

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  payload?: unknown;
}

export type RoutineInputBinding =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "variableRef"; ref: string }
  | { kind: "contextVariableRef"; contextVariable: string };

export type RoutineStepMode = "typed" | "untyped";

/**
 * A Routine is an authored graph of steps connected by conditional transitions.
 * A `chat` step's `action` is projected into a steering rule (it steers the reply);
 * a `skill` step dispatches `skillName`; a `terminal` step ends the routine. A `consent` step asks
 * the routine's consent `consentKey` before the step its default exit leads to (#1544).
 */
export interface RoutineStep {
  id: string;
  kind: "chat" | "skill" | "action" | "terminal" | "await" | "consent";
  /** Instruction projected into steering for a `chat`/`terminal` step. */
  action?: string;
  /** The skill a `skill` step dispatches. */
  skillName?: string;
  /**
   * The action an `action` step emits (fire-and-forget): the engine records an
   * {@link RoutineActionRequest} with this `type` and the routine's variables as the
   * payload, then auto-advances. The `type` is authored here — never chosen by the
   * model — so an emitted action can't be redirected by user/payload text.
   */
  actionType?: string;
  /** The {@link RoutineConsent.key} a `consent` step asks. */
  consentKey?: string;
  decision?: {
    captureKey: string;
    options: DecisionOption[];
  };
  /** Per skill input binding authored for a typed skill step. */
  inputBindings?: Record<string, RoutineInputBinding>;
  /** Per skill output field assignment to a routine variable name. */
  outputAssignments?: Record<string, string>;
  /** Skill-step mode. Absence is treated as typed by routine authoring. */
  mode?: RoutineStepMode;
  /** A `chat` step that shows a skill step's results as cards (#1763). */
  present?: RoutineStepPresent;
  metadata?: Record<string, unknown>;
}

/**
 * Where a presenting step's cards come from and where a pick goes. `from` is the skill step whose
 * staged result the cards are drawn from; the host draws them only on the turn that step ran.
 * `slot` is the `item` slot the visitor's pick fills, and a step that names one has `single`.
 */
export interface RoutineStepPresent {
  from: string;
  selection: "none" | "single";
  slot?: string;
}

/**
 * The value an `item` slot holds: the card the visitor picked, copied by the host from the block
 * that showed it. `fields` is a bounded copy of the record's own top-level scalars. An item the
 * visitor named in text, where no card was picked, holds its name as key and title, and no fields.
 * Every reader that expects a scalar reads its title ({@link readableSlotValue}).
 */
export interface RoutineItemValue {
  key: string;
  title: string;
  link?: string;
  fields: Record<string, string | number | boolean>;
}

/**
 * A card the visitor picked from a routine step's reply, as the host read it from the stored block:
 * the routine and step that showed it, the slot the step binds, and the item. The engine fills the
 * slot only while the routine still waits on that step.
 */
export interface RoutineItemSelection {
  routineId: string;
  stepId: string;
  slot: string;
  item: RoutineItemValue;
}

/**
 * The authored text an operator notice renders from, carried on a compiled terminal step's
 * `metadata.operatorNotice` exactly when that ending notifies operators. Either text may hold
 * `{{slot.<key>}}` references the host substitutes; an absent text means the host's default
 * for the ending's kind. `skillName` names the host skill that delivers the notice; absent
 * means the host's default destination. `replyToSlot` is the key of the collected slot whose
 * value replies to the notice go to; absent means no reply-to. The engine reports the template,
 * it never renders or delivers it.
 */
export interface RoutineOperatorNoticeTemplate {
  subject?: string;
  intro?: string;
  skillName?: string;
  replyToSlot?: string;
  /** Ask the host to append a background-generated, non-slot conversation summary. */
  includeAiSummary?: boolean;
}

/** The kinds an authored `terminal` step declares in `metadata.terminalKind`. */
export type RoutineAuthoredTerminalKind = "complete" | "handoff" | "action";

/**
 * How a routine run ended. An authored kind means the run reached a `terminal` step of that
 * kind. `stuck` and `consent_declined` are the runner's own endings, never authored, and both
 * hand the conversation to a person: `stuck` when the visitor stayed stuck on one chat step past
 * the re-ask limit on a routine with a hand-off end (#1384), `consent_declined` when a consent
 * whose decline choice is `handoff` was declined or could not be asked (#1544). Neither runs a
 * terminal step or the completion export.
 */
export type RoutineTerminalKind = RoutineAuthoredTerminalKind | "stuck" | "consent_declined";

/** The endings that hand the conversation to a person. */
export type RoutineHandoffTerminalKind = Extract<RoutineTerminalKind, "handoff" | "stuck" | "consent_declined">;

export interface RoutineCompletionExport {
  enabled: boolean;
  triggerKinds: Array<"complete" | "handoff">;
  destinationRef: string;
}

export interface RoutineTransition {
  from: string;
  to: string;
  /** Condition the next-step selector evaluates to decide whether this edge fires. */
  condition: string;
  /** Optional deterministic guard. Absent/llm preserves legacy selector behavior. */
  guard?: RoutineGuard;
  /** Set only on an LLM transition synthesized from a plain collection step's default edge. */
  origin?: "compiler_slot_gate";
}

/**
 * Operators a deterministic field guard evaluates against a resolved value.
 * `gt`/`gte`/`lt`/`lte` are numeric; `older_than`/`within` compare a date against
 * `now ± (value × unit)`.
 */
export type RoutineFieldGuardOp =
  | "is_true"
  | "is_false"
  | "equals"
  | "not_equals"
  | "in"
  | "is_present"
  | "is_absent"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "older_than"
  | "within";

export type RoutineFieldGuardValue = string | number | boolean;

/** Duration unit for relative date comparisons (`older_than` / `within`). */
export type RoutineFieldGuardUnit = "days" | "weeks" | "months" | "years";

export type RoutineGuard =
  | { kind: "slot_filled"; slots: string[] }
  | { kind: "outcome"; status: RoutineSkillOutcomeStatus }
  | { kind: "counter"; limit: number }
  /**
   * Deterministic branch on a resolved value — a typed field from the last skill
   * result's `outputs`, or a captured slot — evaluated in code before the model is
   * ever consulted. `ref` resolves against skill outputs first, then slot variables.
   * `unit` applies to the relative-date operators (`older_than` / `within`).
   */
  | { kind: "field"; ref: string; op: RoutineFieldGuardOp; value?: RoutineFieldGuardValue; values?: RoutineFieldGuardValue[]; unit?: RoutineFieldGuardUnit }
  | { kind: "default" }
  | { kind: "llm" };

export type RoutineSlotType = "text" | "number" | "boolean" | "email" | "date" | "item";

export interface RoutineSlotSchema {
  id: string;
  key: string;
  type: RoutineSlotType;
  required: boolean;
  description?: string;
  /** When true, the captured value may be corrected after the routine completes. */
  mutable?: boolean;
  /** Absent means `normal`. A sensitive slot's value is masked in every copy the engine hands out. */
  sensitivity?: ValueSensitivity;
}

/**
 * Reentry policy for a completed routine instance within a conversation.
 * - `once_per_conversation` (default): a completed instance suppresses future
 *   activation in the same conversation.
 * - `always`: a completed instance never suppresses; the trigger may fire again.
 * - `semantic`: a model gate decides whether the completed instance re-opens; it
 *   never re-enters through fresh ranked activation.
 */
export type RoutineReentryMode = "once_per_conversation" | "always" | "semantic";

/**
 * The author-chosen activation policy compiled onto a routine. It is the single
 * source of truth for every consumer that decides whether a routine may start:
 * the host registry's completed-instance suppression and the semantic reentry gate
 * both read it here, so the two cannot drift apart.
 */
export interface RoutineActivation {
  /** Natural-language description of what makes this routine the right one to start. */
  triggerDescription: string;
  priority: number;
  reentryMode: RoutineReentryMode;
  /** Optional skill/gate the host consults before offering the routine. */
  gateRef?: string;
  /** Optional typed semantic gate; absent retains the historical activation path. */
  coverageCriteria?: AnswerCoverageCriteria;
}

export interface Routine {
  id: string;
  rootStepId: string;
  /** Optional typed slot schema. Routines without it keep legacy traversal behavior. */
  slots?: RoutineSlotSchema[];
  steps: RoutineStep[];
  transitions: RoutineTransition[];
  /** Optional terminal-triggered export emitted as a generic routine action. */
  completionExport?: RoutineCompletionExport;
  /**
   * Authored activation policy. Absent on hand-built routines, which the host
   * treats as `once_per_conversation`.
   */
  activation?: RoutineActivation;
  /** The consents the routine asks before it collects the slots each covers (#1544). */
  consents?: RoutineConsent[];
  metadata?: Record<string, unknown>;
}
