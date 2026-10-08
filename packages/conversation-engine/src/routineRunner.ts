import type {
  ConversationRoutineClaim,
  ConversationRoutineNextStepSelector,
  ConversationRoutineResumeInput,
  ConversationRoutineResumeResult,
  ConversationRoutineRunner,
  ConversationRoutineSkillDispatcher,
  ConversationRoutineStepRenderer,
  PendingRenderableTurn,
  Routine,
  RoutineActionRequest,
  RoutineAuthoredTerminalKind,
  RoutineContextRenderer,
  RoutineGuard,
  RoutineNextStepDecision,
  RoutineOperatorNoticeTemplate,
  RoutinePendingStep,
  RoutineRunTrace,
  RoutineSelectionTrace,
  RoutineSkillResult,
  RoutineState,
  RoutineStep,
  RoutineStepReask,
  RoutineStepReplyInput,
  RoutineTraceRejectedSlot,
  RoutineTraceSlotValue,
  RoutineTraceStepEntry,
  RoutineTransition,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";

import {
  collectedSlotsForStep,
  isSlotCollectionStepSatisfied,
  requiredCollectedSlots,
  slotFilledGuardPasses,
} from "./slotCollectionStep.js";
import { checkSlotValue } from "./slotValue.js";

type RoutineFieldGuard = Extract<RoutineGuard, { kind: "field" }>;

/**
 * Resolve a field guard's `ref` to a concrete value: the last skill result's typed
 * `outputs` take precedence (the tool computed it), then captured slot variables.
 * Returns `undefined` when nothing provides the reference.
 */
const resolveFieldValue = (
  ref: string,
  variables: Record<string, unknown>,
  skillResult?: RoutineSkillResult,
): unknown => {
  const readPath = (source: Record<string, unknown>, path: string[]): unknown => {
    let value: unknown = source;
    for (const segment of path) {
      if (typeof value !== "object" || value === null || !Object.prototype.hasOwnProperty.call(value, segment)) {
        return undefined;
      }
      value = (value as Record<string, unknown>)[segment];
    }
    return value;
  };
  const path = ref.split(".");
  const outputs = skillResult?.outputs;
  if (outputs && Object.prototype.hasOwnProperty.call(outputs, ref)) {
    return outputs[ref];
  }
  if (outputs && path.length > 1) {
    const nested = readPath(outputs, path);
    if (nested !== undefined) {
      return nested;
    }
  }
  if (Object.prototype.hasOwnProperty.call(variables, ref)) {
    return variables[ref];
  }
  if (path.length > 1) {
    return readPath(variables, path);
  }
  return undefined;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

// `now` minus (amount × unit), using calendar arithmetic so "6 months" respects month
// boundaries (the date math the model gets wrong — done once, in code).
const subtractDuration = (now: Date, amount: number, unit: NonNullable<RoutineFieldGuard["unit"]>): Date => {
  const result = new Date(now.getTime());
  switch (unit) {
    case "days":
      result.setDate(result.getDate() - amount);
      break;
    case "weeks":
      result.setDate(result.getDate() - amount * 7);
      break;
    case "months":
      result.setMonth(result.getMonth() - amount);
      break;
    case "years":
      result.setFullYear(result.getFullYear() - amount);
      break;
  }
  return result;
};

/**
 * Evaluate a deterministic field guard in code — no model call. This is the branch
 * that lets a routine decide on tool-computed facts (e.g. `is_final_sale === true`,
 * `status in {…}`, `order_date older_than 6 months`) with the same certainty every time.
 */
const evaluateFieldGuard = (
  guard: RoutineFieldGuard,
  variables: Record<string, unknown>,
  skillResult: RoutineSkillResult | undefined,
  now: Date,
): boolean => {
  const actual = resolveFieldValue(guard.ref, variables, skillResult);
  switch (guard.op) {
    case "is_true":
      return actual === true;
    case "is_false":
      return actual === false;
    case "is_present":
      return actual !== undefined && actual !== null;
    case "is_absent":
      return actual === undefined || actual === null;
    case "equals":
      return actual === guard.value;
    case "not_equals":
      return actual !== guard.value;
    case "in":
      return Array.isArray(guard.values) && guard.values.some((candidate) => candidate === actual);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = toNumber(actual);
      const right = toNumber(guard.value);
      if (left === null || right === null) return false;
      if (guard.op === "gt") return left > right;
      if (guard.op === "gte") return left >= right;
      if (guard.op === "lt") return left < right;
      return left <= right;
    }
    case "older_than":
    case "within": {
      const date = toDate(actual);
      const amount = toNumber(guard.value);
      if (date === null || amount === null || !guard.unit) return false;
      const threshold = subtractDuration(now, amount, guard.unit);
      return guard.op === "older_than" ? date.getTime() < threshold.getTime() : date.getTime() >= threshold.getTime();
    }
    default:
      return false;
  }
};

/**
 * Projects a step's `action` into a routine steering rule — the keystone that lets
 * a routine step steer the reply through the same steering set authored Directives
 * use. A step with no action (a bare skill step) projects nothing.
 */
const projectStep = (step: RoutineStep): SteeringRule[] =>
  step.action
    ? [{
        action: step.action,
        source: "routine",
        lifespan: "response",
        description: `routine step ${step.id}`,
      }]
    : [];

// A step instruction embeds two kinds of reference: `{{slot.<key>}}` reads a captured
// variable, `{{context.<name>}}` reads a staged context variable (the visitor's current
// page, a host-pushed value). Both resolve in ONE pass over the authored text, so a value
// substituted for one reference is never re-scanned for the other — a visitor-typed slot
// value or a page title cannot smuggle a second reference in.
const STEP_REFERENCE = /\{\{\s*(slot|context)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;

const stringifySlotValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return value.toString();
  }
  if (value === null || value === undefined) {
    return "";
  }
  return Array.isArray(value) ? value.toString() : Object.prototype.toString.call(value);
};

/**
 * Fills captured slots and referenced context into a step's authored instruction before it
 * is rendered. The host's renderer decides what any context variable looks like; the engine
 * only substitutes. An uncaptured slot, an absent or withheld context variable, or no
 * context renderer at all leaves an empty string, never the raw token.
 */
const resolveStepAction = (
  action: string,
  variables: Record<string, unknown>,
  stagedContext: TurnContext["stagedContext"],
  contextRenderer: RoutineContextRenderer | undefined,
): string =>
  action.replace(STEP_REFERENCE, (_match, kind: string, name: string) => {
    if (kind === "context") {
      return contextRenderer?.render({ name, stagedContext }) ?? "";
    }
    return Object.prototype.hasOwnProperty.call(variables, name) ? stringifySlotValue(variables[name]) : "";
  });

const assignOutputs = (
  outputAssignments: Record<string, string> | undefined,
  outputs: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  if (!outputAssignments || !outputs) {
    return {};
  }
  const assigned: Record<string, unknown> = {};
  for (const [outputField, variableName] of Object.entries(outputAssignments)) {
    if (Object.prototype.hasOwnProperty.call(outputs, outputField)) {
      assigned[variableName] = outputs[outputField];
    }
  }
  return assigned;
};

const stagedContextForSkillResult = (
  step: RoutineStep,
  result: RoutineSkillResult,
): TurnContext["stagedContext"][number] | null => {
  if (!result.outputs) {
    return null;
  }
  return {
    kind: "skill_result",
    ...(step.skillName ? { source: step.skillName } : {}),
    data: result.outputs,
    metadata: {
      stepId: step.id,
      status: result.status,
      ...(result.metadata ? { skillMetadata: result.metadata } : {}),
    },
  };
};

const hasTypedSlotSchema = (routine: Routine): boolean =>
  Array.isArray(routine.slots) && routine.slots.length > 0;

const hasVariable = (variables: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(variables, key);

/**
 * What a re-rendered step still lacks: its required collected slots that are unfilled, and
 * any collected slot whose value this turn was rejected for not fitting its type, as
 * declared schema — never values. `null` when the step collects required slots, holds them
 * all, and rejected nothing: it stayed for another reason, and telling the renderer the reply
 * "fell short" made it ask again for values it already had. An optional slot counts as
 * missing only when its value was rejected.
 */
const reaskFor = (
  routine: Routine,
  step: RoutineStep,
  variables: Record<string, unknown>,
  rejectedKeys: ReadonlySet<string>,
): RoutineStepReask | null => {
  const collected = new Set(collectedSlotsForStep(step));
  const required = requiredCollectedSlots(routine, step);
  const missingSlots = (routine.slots ?? []).filter((slot) =>
    collected.has(slot.key) && (rejectedKeys.has(slot.key) || (slot.required && !hasVariable(variables, slot.key))),
  );
  return required.length > 0 && missingSlots.length === 0 ? null : { missingSlots };
};

/**
 * Consecutive no-progress re-asks of one step before the reply is told to ask differently
 * (#1376).
 */
const DEFAULT_REASK_LIMIT = 3;

/**
 * Turns a step asks differently, past the re-ask limit, before a routine with a hand-off end
 * stops asking and hands the stuck visitor to a person (#1384).
 */
const ASK_DIFFERENTLY_TURNS_BEFORE_HANDOFF = 1;

/**
 * Keeps the values that fit their declared slot type, in that type's canonical form (#1374).
 * On a routine with no slot schema there is nothing to check a key against, so every key
 * passes through as it always has. On a routine that declares one, a key the schema does
 * not list is dropped and reported as "undeclared" (#1388) — the turn planner, ranked
 * activation, and a selector return free-form field names, and only a declared slot's
 * value may reach routine state, an action payload, or an unbound tool-step input. A blank
 * value is "not given" and dropped silently; one that does not fit its declared type is
 * dropped and reported by key and reason — never by value.
 */
const checkDeclaredSlotValues = (
  routine: Routine,
  values: Record<string, unknown>,
): { values: Record<string, unknown>; rejected: RoutineTraceRejectedSlot[] } => {
  const slotTypes = new Map((routine.slots ?? []).map((slot) => [slot.key, slot.type]));
  const kept: Record<string, unknown> = {};
  const rejected: RoutineTraceRejectedSlot[] = [];
  for (const [key, value] of Object.entries(values)) {
    const type = slotTypes.get(key);
    if (!type) {
      if (slotTypes.size > 0) {
        rejected.push({ key, reason: "undeclared" });
      } else {
        kept[key] = value;
      }
      continue;
    }
    const checked = checkSlotValue(type, value);
    if (checked.ok) {
      kept[key] = checked.value;
    } else if (checked.reason !== "empty") {
      rejected.push({ key, reason: checked.reason });
    }
  }
  return { values: kept, rejected };
};

/** The rejected keys that belong to slots this step collects. */
const rejectedCollectedKeys = (step: RoutineStep, rejected: readonly RoutineTraceRejectedSlot[]): Set<string> => {
  const collected = new Set(collectedSlotsForStep(step));
  return new Set(rejected.map((slot) => slot.key).filter((key) => collected.has(key)));
};

/**
 * Whether the turn filled a slot the step collects that was empty before it: progress that
 * resets the re-ask count. Replacing a value the step already held is not progress, or a
 * visitor restating an optional value with each failed answer would never reach the limit.
 */
const filledCollectedSlot = (
  step: RoutineStep,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean =>
  collectedSlotsForStep(step).some((key) => !hasVariable(before, key) && hasVariable(after, key));

/**
 * The step a yielding routine stays parked on. The host puts it into the answer's system
 * prompt, so it carries no captured value: a captured value is visitor text, and a slot
 * reference shows as its bracketed key instead ("Ask [name] for the dates"). The routine
 * claims nothing this turn, so the context staged for the turn (the visitor's page) is not
 * the routine's to read either, and a context reference renders empty.
 */
const pendingStepFor = (
  routine: Routine,
  step: RoutineStep,
  variables: Record<string, unknown>,
): RoutinePendingStep => ({
  stepId: step.id,
  instruction: (step.action ?? "").replace(STEP_REFERENCE, (_match, kind: string, name: string) =>
    kind === "slot" ? `[${name}]` : ""),
  missingSlotKeys: requiredCollectedSlots(routine, step)
    .filter((slot) => !hasVariable(variables, slot.key))
    .map((slot) => slot.key),
});

const declaredSlotVariables = (
  routine: Routine,
  variables: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    (routine.slots ?? [])
      .map((slot) => slot.key)
      .filter((key) => hasVariable(variables, key))
      .map((key) => [key, variables[key]]),
  );

/** Per-value character bound for a traced slot value (including the ellipsis), matching the host's output-bounding magnitude. */
const MAX_TRACE_SLOT_VALUE_CHARS = 500;

/** Filled-slot count bound for one turn's traced slot values. */
const MAX_TRACE_SLOT_VALUES = 50;

/** Narrows a captured slot value to the scalar shape a trace can carry, and caps its length. */
const traceableSlotValue = (value: unknown): { value: string | number | boolean; truncated?: boolean } => {
  const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : JSON.stringify(value) ?? String(value);
  if (typeof scalar === "string" && scalar.length > MAX_TRACE_SLOT_VALUE_CHARS) {
    // The ellipsis counts toward the bound, so the kept slice is one character short of it.
    return { value: `${scalar.slice(0, MAX_TRACE_SLOT_VALUE_CHARS - 1)}…`, truncated: true };
  }
  return { value: scalar };
};

/**
 * Every filled declared slot's value after this turn, self-described by its declared
 * type, capped to `MAX_TRACE_SLOT_VALUES` entries with each value capped to
 * `MAX_TRACE_SLOT_VALUE_CHARS`. Called only when the runner's `includeSlotValues`
 * construction option is set — this is the one place the trace carries slot *values*
 * rather than just keys, and it never runs otherwise.
 */
const declaredSlotTraceValues = (
  routine: Routine,
  variables: Record<string, unknown>,
): { slotValues: RoutineTraceSlotValue[]; omittedSlotCount: number } => {
  const filled = (routine.slots ?? []).filter((slot) => hasVariable(variables, slot.key));
  const kept = filled.slice(0, MAX_TRACE_SLOT_VALUES);
  return {
    slotValues: kept.map((slot) => {
      const { value, truncated } = traceableSlotValue(variables[slot.key]);
      return { key: slot.key, type: slot.type, value, ...(truncated ? { truncated: true } : {}) };
    }),
    omittedSlotCount: filled.length - kept.length,
  };
};

/** The `slotValues`/`omittedSlotCount` fields to spread onto a trace, present only when requested. */
const slotValuesTraceFields = (
  routine: Routine,
  variables: Record<string, unknown>,
  includeSlotValues: boolean | undefined,
): Pick<RoutineRunTrace, "slotValues" | "omittedSlotCount"> => {
  if (!includeSlotValues) {
    return {};
  }
  const { slotValues, omittedSlotCount } = declaredSlotTraceValues(routine, variables);
  return { slotValues, ...(omittedSlotCount > 0 ? { omittedSlotCount } : {}) };
};

/**
 * Runner-local gate on top of the shared `isSlotCollectionStepSatisfied` rule: only a
 * chat step on a routine with a typed slot schema can be fast-forwarded past.
 */
const isSatisfiedSlotCollectionStep = (
  routine: Routine,
  step: RoutineStep,
  variables: Record<string, unknown>,
): boolean => {
  if (step.kind !== "chat" || !hasTypedSlotSchema(routine)) {
    return false;
  }
  return isSlotCollectionStepSatisfied(routine, step, variables);
};

const isDefaultTransition = (transition: RoutineTransition): boolean =>
  transition.guard?.kind === "default";

const isLlmTransition = (transition: RoutineTransition): boolean =>
  !transition.guard || transition.guard.kind === "llm";

const isCompilerSlotGate = (transition: RoutineTransition): boolean =>
  transition.origin === "compiler_slot_gate" && isLlmTransition(transition);

const terminalKindFor = (step: RoutineStep): RoutineAuthoredTerminalKind | null => {
  if (step.kind !== "terminal") {
    return null;
  }
  const kind = step.metadata?.terminalKind;
  return kind === "handoff" || kind === "action" || kind === "complete" ? kind : "complete";
};

/**
 * Whether the author routed some path of this routine to a hand-off end — people take its
 * conversations over, so a visitor stuck on a step can go to one (#1384). A routine no exit
 * leads to a hand-off step declares no such path.
 */
const routesToHandoff = (routine: Routine): boolean =>
  routine.transitions.some((transition) => {
    const target = routine.steps.find((step) => step.id === transition.to);
    return target !== undefined && terminalKindFor(target) === "handoff";
  });

const terminalResult = (
  kind: RoutineAuthoredTerminalKind,
  step: RoutineStep,
  collected: Record<string, unknown>,
): NonNullable<ConversationRoutineResumeResult["terminal"]> => {
  const operatorNotice = operatorNoticeTemplateFor(step);
  return { kind, stepId: step.id, collected, ...(operatorNotice ? { operatorNotice } : {}) };
};

/**
 * The operator notice template a terminal step carries. The host's compiler puts it there
 * exactly when the ending notifies operators; the runner only reads it back, keeping the
 * text fields that are strings so a malformed metadata value can never reach a notice.
 */
const operatorNoticeTemplateFor = (step: RoutineStep): RoutineOperatorNoticeTemplate | null => {
  const notice = step.kind === "terminal" ? step.metadata?.operatorNotice : undefined;
  if (typeof notice !== "object" || notice === null || Array.isArray(notice)) {
    return null;
  }
  const { subject, intro } = notice as Record<string, unknown>;
  return {
    ...(typeof subject === "string" ? { subject } : {}),
    ...(typeof intro === "string" ? { intro } : {}),
  };
};

const completionExportActionFor = (
  routine: Routine,
  step: RoutineStep,
  terminalKind: RoutineAuthoredTerminalKind | null,
  variables: Record<string, unknown>,
): RoutineActionRequest | null => {
  const completionExport = routine.completionExport;
  if (
    !completionExport?.enabled ||
    !completionExport.destinationRef ||
    (terminalKind !== "complete" && terminalKind !== "handoff") ||
    !completionExport.triggerKinds.includes(terminalKind)
  ) {
    return null;
  }

  return {
    type: "webhook.send",
    payload: {
      destinationRef: completionExport.destinationRef,
      source: {
        routineId: routine.id,
        stepId: step.id,
        terminalKind,
        status: "completed",
      },
      data: declaredSlotVariables(routine, variables),
    },
  };
};

/**
 * Walks a registered Routine graph for the current turn: it asks the injected
 * next-step selector which step the turn lands on, captures slot variables, runs
 * through any skill (tool) steps it lands on — dispatching the skill and advancing
 * (a single outgoing edge auto-advances; multiple edges defer to the selector with
 * the skill result) — then projects the landed chat/terminal step into steering and
 * renders the reply through the host step renderer. The pure engine owns the graph
 * mechanics; generation/presentation stays in the host. Implements the slice-1
 * `ConversationRoutineRunner` seam, so the engine resumes through it unchanged.
 */
interface DefaultRoutineRunnerOptions {
  /** Time source for relative-date guards; defaults to the wall clock. */
  clock?: () => Date;
  /** Renders `{{context.<name>}}` references in step instructions; absent means they resolve to nothing. */
  contextRenderer?: RoutineContextRenderer;
  /**
   * Whether this runner's trace includes each filled slot's value. Absent/false (the
   * default) is what every live customer conversation gets — the trace it builds is
   * exactly what feeds a persisted audit record, so no value is ever produced for it in
   * the first place. Only a construction the host builds specifically for a private
   * replay (Test Chat, eval) sets this.
   */
  includeSlotValues?: boolean;
  /** Consecutive no-progress re-asks of one step allowed before the reply asks differently; defaults to 3. */
  reaskLimit?: number;
}

export class DefaultRoutineRunner implements ConversationRoutineRunner {
  constructor(
    private readonly routines: readonly Routine[],
    private readonly selector: ConversationRoutineNextStepSelector,
    private readonly renderer: ConversationRoutineStepRenderer,
    private readonly skillDispatcher?: ConversationRoutineSkillDispatcher,
    private readonly options: DefaultRoutineRunnerOptions = {},
  ) {}

  // Injectable so relative-date guards ("older_than 6 months") are deterministic in tests.
  private get clock(): () => Date {
    return this.options.clock ?? (() => new Date());
  }

  getCurrentStep(state: RoutineState): RoutineStep | null {
    const routine = this.routines.find((candidate) => candidate.id === state.routineId);
    if (!routine) {
      return null;
    }
    const stepId = state.path.at(-1) ?? routine.rootStepId;
    return routine.steps.find((candidate) => candidate.id === stepId) ?? null;
  }

  async resume(input: ConversationRoutineResumeInput): Promise<ConversationRoutineResumeResult> {
    const claim = await this.claim(input);
    if (claim.kind === "yielded") {
      return { yielded: true, response: { answer: "" }, nextState: null, pendingStep: claim.pendingStep };
    }
    return { response: await claim.reply.render(), ...claim.effects };
  }

  /** The reply for a step, generated only when the claim's holder asks for it. */
  private prepareReply(input: RoutineStepReplyInput): PendingRenderableTurn {
    return this.renderer.prepare?.(input) ?? { render: () => this.renderer.render(input) };
  }

  /**
   * Walks the routine for this turn and decides everything it does — where it lands, what it
   * captures, which actions it emits, how it ends — before any reply text exists. The reply
   * is the last thing every branch produces and nothing here reads it.
   */
  async claim(input: ConversationRoutineResumeInput): Promise<ConversationRoutineClaim> {
    const { turn } = input;
    const now = this.clock();
    const routine = this.routines.find((candidate) => candidate.id === input.state.routineId);
    if (!routine) {
      throw new Error(`routine_not_found:${input.state.routineId}`);
    }
    // The values a routine starts with — the activator's extraction, or what a re-entered run
    // carries — enter its state here, so they are checked like any selector's (#1374).
    const startCheck = input.activationTurn ? checkDeclaredSlotValues(routine, input.state.variables) : null;
    const state: RoutineState = startCheck ? { ...input.state, variables: startCheck.values } : input.state;
    // The activator's rejections the selector did not make good: the selector reads the same
    // opening message, so a valid value it returns for the slot replaces the rejected one.
    const unreplacedStartRejections = (variables: Record<string, unknown>): RoutineTraceRejectedSlot[] =>
      (startCheck?.rejected ?? []).filter((rejected) => !hasVariable(variables, rejected.key));
    // Every next state sets the re-ask count afresh for the step it rests on (#1376).
    const { reaskCount: _previousReaskCount, ...stateWithoutReaskCount } = state;
    const stepById = (id: string): RoutineStep => {
      const step = routine.steps.find((candidate) => candidate.id === id);
      if (!step) {
        throw new Error(`routine_step_not_found:${routine.id}:${id}`);
      }
      return step;
    };
    const outgoing = (stepId: string): RoutineTransition[] => routine.transitions.filter((t) => t.from === stepId);
    // Constrain a selector's choice to the current step (stay / re-ask) or a declared
    // successor — a selector (LLM or buggy) MUST NOT be able to jump the turn to an
    // arbitrary step (e.g. an early terminal, dropping the routine, or into a skill
    // cycle). Anything else falls back to staying put.
    const landingStepId = (fromStepId: string, decision: { nextStepId: string }): string => {
      const allowed = new Set([fromStepId, ...outgoing(fromStepId).map((t) => t.to)]);
      return allowed.has(decision.nextStepId) ? decision.nextStepId : fromStepId;
    };

    const currentStepId = state.path.at(-1) ?? routine.rootStepId;
    const currentStep = stepById(currentStepId);
    // A yield leaves the saved state untouched, so the routine waits on the step it resumed
    // on, whatever this message would have filled or walked past.
    const yieldTurn = (): ConversationRoutineClaim => ({
      kind: "yielded",
      pendingStep: pendingStepFor(routine, currentStep, state.variables),
    });

    // Debug trace: a step-by-step log of this turn's traversal, surfaced to the panel.
    // Slot KEYS only — never the captured values (which may be PII).
    const declaredSlotKeys = new Set((routine.slots ?? []).map((slot) => slot.key));
    const traceSteps: RoutineTraceStepEntry[] = [];
    const capturedKeysFrom = (
      before: Record<string, unknown>,
      decision?: { variables?: Record<string, unknown> },
    ): string[] => {
      if (!decision?.variables) {
        return [];
      }
      return Object.keys(decision.variables).filter(
        (key) => !hasVariable(before, key) && (declaredSlotKeys.size === 0 || declaredSlotKeys.has(key)),
      );
    };
    // Set by `selectNext` each call: whether it consulted the LLM selector (vs taking a
    // default/structured-guard edge), and what the selector reported its model returned.
    // Read immediately after each awaited call.
    let lastSelectorRan = false;
    let lastSelection: RoutineSelectionTrace | undefined;
    // The slots whose returned value the last `selectNext` call did not store (#1374).
    let lastRejectedSlots: RoutineTraceRejectedSlot[] = [];
    // Whether a selector decision in the last `selectNext` call asked to hold its step (#1375).
    let lastSelectorHold = false;
    // Every selector call goes through here, so no selector implementation can store a value
    // that does not fit its slot's declared type.
    const selectChecked = async (
      selectInput: Parameters<ConversationRoutineNextStepSelector["select"]>[0],
    ): Promise<RoutineNextStepDecision> => {
      const decision = await this.selector.select(selectInput);
      lastSelection = decision.selection;
      lastSelectorHold = lastSelectorHold || decision.hold === true;
      if (!decision.variables) {
        return decision;
      }
      const checked = checkDeclaredSlotValues(routine, decision.variables);
      lastRejectedSlots = [...lastRejectedSlots, ...checked.rejected];
      return { ...decision, variables: checked.values };
    };

    const attempts: Record<string, number> = { ...(state.attempts ?? {}) };
    if (state.path.length === 0) {
      attempts[currentStepId] = (attempts[currentStepId] ?? 0) + 1;
    }
    const enterStep = (nextStep: RoutineStep, path: string[]): void => {
      path.push(nextStep.id);
      attempts[nextStep.id] = (attempts[nextStep.id] ?? 0) + 1;
    };
    const guardMatches = (
      transition: RoutineTransition,
      fromStepId: string,
      variables: Record<string, unknown>,
      skillResult?: RoutineSkillResult,
    ): boolean => {
      switch (transition.guard?.kind) {
        case "slot_filled":
          return slotFilledGuardPasses(transition, variables);
        case "outcome":
          return skillResult?.status === transition.guard.status;
        case "counter":
          return (attempts[fromStepId] ?? 0) < transition.guard.limit;
        case "field":
          return evaluateFieldGuard(transition.guard, variables, skillResult, now);
        default:
          return false;
      }
    };
    // Where a satisfied slot step goes by its rules alone: the first rule exit whose guard
    // passes, else its default exit. A rule exit leaves only when its guard passes, even as
    // the only exit (#1391). `undefined` when no rule or default exit moves it.
    const ruleExit = (
      step: RoutineStep,
      exits: readonly RoutineTransition[],
      variables: Record<string, unknown>,
    ): string | undefined =>
      (exits.find((exit) => !isDefaultTransition(exit) && !isLlmTransition(exit) && guardMatches(exit, step.id, variables))
        ?? exits.find(isDefaultTransition))?.to;
    // Where a satisfied slot step goes when its structure decides: its compiler-generated
    // slot gate, else its rule exit. An unmarked AI-decides edge is authored and can leave
    // only when the selector chooses it.
    const satisfiedStepExit = (
      step: RoutineStep,
      exits: readonly RoutineTransition[],
      variables: Record<string, unknown>,
    ): string | undefined =>
      exits.length === 1 && isCompilerSlotGate(exits[0])
        ? exits[0].to
        : ruleExit(step, exits, variables);
    type SelectNextInput = {
      step: RoutineStep;
      transitions: RoutineTransition[];
      variables: Record<string, unknown>;
      state: RoutineState;
      skillResult?: RoutineSkillResult;
      defaultOnDecline?: boolean;
      /** Extract even when the step's slots are filled: nothing has read this message yet. */
      alwaysExtract?: boolean;
      /** The step the visitor answered: a rejected value for one of its own slots holds it this turn. */
      answeredStep?: boolean;
    };
    const selectNextRaw = async (input: SelectNextInput): Promise<RoutineNextStepDecision> => {
      lastSelectorRan = false;
      lastSelection = undefined;
      lastRejectedSlots = [];
      lastSelectorHold = false;
      const defaultTransition = input.transitions.find(isDefaultTransition);
      const conditionedTransitions = input.transitions.filter((transition) => !isDefaultTransition(transition));

      // A slot-collection step must capture the user's answer even when all of its
      // branches are deterministic (a field/counter guard, or a bare default) — the
      // selector is the only place variables are extracted, yet it normally runs only
      // for an `llm` edge. A step that asks for {{slot.x}} and then branches on x in
      // code therefore never captured x (so the branch could never see it). When no
      // `llm` edge will trigger the selector, run an extraction-only pass first and let
      // the deterministic guards below decide the branch from the merged values.
      //
      // Only when at least one collected slot is still missing. A step already holding
      // every collected slot has nothing to extract — running the selector there would add
      // a model round-trip to a deterministic path, let an unrelated message overwrite an
      // already-filled slot, and could spuriously yield the turn.
      const collected = collectedSlotsForStep(input.step);
      let extracted: Record<string, unknown> = {};
      if (
        collected.length > 0 &&
        (input.alwaysExtract || collected.some((key) => !hasVariable(input.variables, key))) &&
        input.transitions.length > 0 &&
        !conditionedTransitions.some(isLlmTransition)
      ) {
        lastSelectorRan = true;
        const extraction = await selectChecked({
          routine,
          state: input.state,
          currentStep: input.step,
          transitions: input.transitions,
          turn,
          ...(input.skillResult ? { skillResult: input.skillResult } : {}),
        });
        // Off-topic on a slot step still yields the turn, same as the llm path.
        if (extraction.yieldTurn) {
          return extraction;
        }
        extracted = extraction.variables ?? {};
      }
      const variables = { ...input.variables, ...extracted };
      // Thread the extraction-only capture onto whatever branch the guards pick, so the
      // caller merges (and the trace records) the slot even though the LLM didn't choose
      // the edge.
      const withExtracted = (decision: RoutineNextStepDecision): RoutineNextStepDecision =>
        Object.keys(extracted).length > 0
          ? { ...decision, variables: { ...extracted, ...(decision.variables ?? {}) } }
          : decision;

      if (defaultTransition && conditionedTransitions.length === 0) {
        return withExtracted({ nextStepId: defaultTransition.to });
      }

      for (const transition of conditionedTransitions) {
        if (guardMatches(transition, input.step.id, variables, input.skillResult)) {
          return withExtracted({ nextStepId: transition.to });
        }
      }

      const llmTransitions = conditionedTransitions.filter(isLlmTransition);
      if (llmTransitions.length === 0) {
        return withExtracted({ nextStepId: defaultTransition?.to ?? input.step.id });
      }

      lastSelectorRan = true;
      const decision = await selectChecked({
        routine,
        state: input.state,
        currentStep: input.step,
        transitions: llmTransitions,
        turn,
        ...(input.skillResult ? { skillResult: input.skillResult } : {}),
      });
      if (decision.yieldTurn) {
        return decision;
      }
      const allowed = new Set([input.step.id, ...llmTransitions.map((transition) => transition.to)]);
      const chosen = allowed.has(decision.nextStepId) ? decision.nextStepId : input.step.id;
      if (chosen === input.step.id) {
        if (input.defaultOnDecline && defaultTransition) {
          return { ...decision, nextStepId: defaultTransition.to };
        }
        // No AI-decides exit held, yet the reply filled what the step asks for: the step is
        // done, so its rule or default exit moves on instead of asking again (#1372).
        const withDecision = { ...variables, ...(decision.variables ?? {}) };
        const exit = isSatisfiedSlotCollectionStep(routine, input.step, withDecision)
          ? satisfiedStepExit(input.step, input.transitions, withDecision)
          : undefined;
        if (exit !== undefined) {
          return { ...decision, nextStepId: exit };
        }
      }
      return { ...decision, nextStepId: chosen };
    };
    const selectNext = async (selectInput: SelectNextInput): Promise<RoutineNextStepDecision> => {
      const decision = await selectNextRaw(selectInput);
      // On the activation turn the user's message is the routine's trigger, not a reply
      // to the current step (which has never been rendered) — an off-topic yield here
      // would silently drop the activation, so land on the step and render it instead.
      if (decision.yieldTurn && !input.activationTurn) {
        return decision;
      }
      const landed: RoutineNextStepDecision = decision.yieldTurn ? { nextStepId: selectInput.step.id } : decision;
      // The hold: the chat step stays and is asked again, whichever exit — AI-decides, rule,
      // or default — would otherwise have fired. The values that did fit are kept. It has two
      // reasons:
      // - an authority claim (#1375): the selector asked to hold the step because the message
      //   carries text posing as a system, operator, or assistant message. It holds any chat
      //   step the selector read the message for: the one the visitor answered, or one reached
      //   by skipping ahead;
      // - a rejected value (#1374): the visitor gave a value for one of the answered step's own
      //   slots that does not fit its type — to the selector this turn, or to the activator in
      //   the opening message with no valid replacement since — so the step is not answered.
      //   A rejected value for another step's slot is dropped and holds nothing.
      // A tool step's follow-up still leaves by its default after a decline, since holding
      // the tool step could run its tool again.
      if (selectInput.defaultOnDecline) {
        return landed;
      }
      const rejected = selectInput.answeredStep
        ? [...lastRejectedSlots, ...unreplacedStartRejections({ ...selectInput.variables, ...(landed.variables ?? {}) })]
        : [];
      const hold = lastSelectorHold || rejectedCollectedKeys(selectInput.step, rejected).size > 0;
      return hold ? { ...landed, nextStepId: selectInput.step.id, hold: true } : landed;
    };

    let step: RoutineStep;
    let variables = { ...state.variables };
    let path: string[];
    // Values rejected on the step the visitor answered and not made good this turn; they
    // are listed as missing on its re-ask.
    let resumeStepRejected: RoutineTraceRejectedSlot[] = [];
    // The activator's rejections for a routine whose root step is itself a transit step:
    // that branch below takes it directly, with no selector call and no trace entry of
    // its own, so nothing else records `startCheck.rejected` for this turn. The transit-
    // step loop further down attaches it to the first entry it pushes, then clears it —
    // one turn reads the opening message once, so only that first hop carries it (#1388).
    let pendingRootRejected: RoutineTraceRejectedSlot[] = [];
    // Whether `selectNext` held the step the visitor answered (see the hold there).
    let held = false;
    if (currentStep.kind === "skill" || currentStep.kind === "action") {
      // Transit steps execute when the routine lands on them. This matters for a
      // routine whose root step is a tool (for example retrieval.context): selecting
      // from its outgoing edges first would skip the tool entirely.
      step = currentStep;
      path = state.path.at(-1) === currentStep.id ? [...state.path] : [...state.path, currentStep.id];
      pendingRootRejected = unreplacedStartRejections(variables);
    } else {
      // Select the step this turn lands on from the current step's outgoing edges.
      // On the activation turn the activator may already have filled this step's slot
      // from the message; the rest of the message (dates given with a program) still has
      // to be read, or it is lost (#1370). A step that holds its slots yet has no exit its
      // rules or default take stayed on a value its rule exit rejected, so the reply is the
      // visitor's new answer and is read too (#1391).
      const awaitsNewAnswer = isSatisfiedSlotCollectionStep(routine, currentStep, state.variables) &&
        satisfiedStepExit(currentStep, outgoing(currentStepId), state.variables) === undefined;
      const decision = await selectNext({
        step: currentStep,
        transitions: outgoing(currentStepId),
        variables: state.variables,
        state: { ...state, attempts },
        ...(input.activationTurn || awaitsNewAnswer ? { alwaysExtract: true } : {}),
        answeredStep: true,
      });
      // The user's message is off-topic for the routine → decline this turn and let
      // normal answering handle it; the routine stays at its current step to resume.
      if (decision.yieldTurn) {
        return yieldTurn();
      }
      held = decision.hold === true;
      const mainSelectorRan = lastSelectorRan;
      const mainSelection = lastSelection;
      const selectorRejected = lastRejectedSlots;
      const tracedRejected = [...(startCheck?.rejected ?? []), ...selectorRejected];
      const landedId = landingStepId(currentStepId, decision);
      step = landedId === currentStepId ? currentStep : stepById(landedId);
      variables = { ...state.variables, ...(decision.variables ?? {}) };
      resumeStepRejected = [...selectorRejected, ...unreplacedStartRejections(variables)];
      // Trace the resume step's outcome: it either advanced off (the user satisfied it) or
      // was re-asked. Captured keys, if any, belong to this step's edge evaluation.
      {
        const captured = capturedKeysFrom(state.variables, decision);
        traceSteps.push({
          stepId: currentStep.id,
          kind: currentStep.kind,
          event: step.id === currentStepId ? "reasked" : "advanced",
          ...(captured.length > 0 ? { capturedSlotKeys: captured } : {}),
          ...(tracedRejected.length > 0 ? { rejectedSlots: tracedRejected } : {}),
          viaSelector: mainSelectorRan,
          ...(mainSelection ? { selection: mainSelection } : {}),
        });
      }
      // Append to the path only on a real advance; re-asking a step keeps it stable.
      path = step.id === currentStepId ? [...state.path] : [...state.path, step.id];
      if (step.id !== currentStepId) {
        attempts[step.id] = (attempts[step.id] ?? 0) + 1;
      }
    }
    let stagedContext = turn.stagedContext;

    // Skip slot-collection steps that are already satisfied, so an intake never re-asks
    // for a value the routine already holds. A satisfied step leaves by its structure — a
    // matching rule exit, else its default — with no model call: the latest message
    // answered an earlier step and has already been read (#1372). Only a step whose way on
    // is an authored AI-decides exit asks the selector. A marked compiler slot gate can
    // advance without one.
    // A bounded loop (a `counter` back-edge into a satisfied step) would otherwise
    // fast-forward forever — track the steps visited this traversal, the transit steps it
    // runs through included, and on a revisit, stop and render the current step instead of
    // throwing. This keeps the runner on the degrade-don't-throw path: a loop that can't
    // fast-forward to progress settles on a chat step the user can act on.
    const fastForwarded = new Set<string>([step.id]);
    // Trace entry for a step whose edges the selector just judged this call: what it ran
    // with and what changed. Shared by the fast-forward and landing-read branches below so
    // both record identically; never called for a step moved on deterministically (no
    // selector call), which builds its own bare entry instead.
    const selectorEntry = (
      forStep: RoutineStep,
      before: Record<string, unknown>,
      decision: RoutineNextStepDecision,
    ): RoutineTraceStepEntry => {
      const entry: RoutineTraceStepEntry = { stepId: forStep.id, kind: forStep.kind, event: "fast_forwarded" };
      if (lastSelectorRan) {
        entry.viaSelector = true;
      }
      if (lastSelection) {
        entry.selection = lastSelection;
      }
      const captured = capturedKeysFrom(before, decision);
      if (captured.length > 0) {
        entry.capturedSlotKeys = captured;
      }
      if (lastRejectedSlots.length > 0) {
        entry.rejectedSlots = lastRejectedSlots;
      }
      return entry;
    };
    // Walks on from `step` until a step holds the turn. Returns true when a selector found the
    // message off-topic and the turn yields. A held step is asked again even when the values
    // it kept, or an earlier value, would satisfy it: nothing is fast-forwarded past it this turn.
    // After a transit step, a step moves on only by a rule or default exit, or by an exit the
    // opening-message read chose: an AI-decides exit judges a reply to this step, and the
    // visitor has given none. Taking one could carry the turn past a confirmation into an
    // action; judging it against the message that answered an earlier step could yield the
    // turn and run the tool again later. Such a step is asked.
    const fastForward = async ({ afterTransit }: { afterTransit: boolean }): Promise<boolean> => {
      const structuralExit = satisfiedStepExit;
      while (!held) {
        if (!isSatisfiedSlotCollectionStep(routine, step, variables)) {
          // Activation turn only (#1370): the message that starts the routine can state
          // values for a step further down the graph than the one it answers directly.
          // Read it once for the step the walk stops on here; a later reply answers the
          // step shown on screen, so this never runs past the first turn. The walk never
          // revisits a step (every advance below lands outside `fastForwarded`, and a step a
          // transit step lands on is walked only on its first entry), so nothing needs to
          // track which steps already had this read.
          if (
            !input.activationTurn ||
            step.kind !== "chat" ||
            step.id === currentStepId ||
            collectedSlotsForStep(step).length === 0
          ) {
            break;
          }

          const landingEdges = outgoing(step.id);
          const beforeLanding = variables;
          const landingDecision = await selectNext({
            step,
            transitions: landingEdges,
            variables,
            state: { ...state, path, variables, attempts, status: "active" },
          });
          const landingEntry = selectorEntry(step, beforeLanding, landingDecision);
          landingEntry.readOpeningMessage = true;
          variables = { ...variables, ...(landingDecision.variables ?? {}) };

          // Moving on requires the step to be satisfied after this merge, checked before
          // `nextStepId`: a lone default edge resolves on its own regardless of what was
          // extracted, right once a step has been asked, wrong for one never shown to the
          // visitor. A hold (#1375) renders the step even when the merge would satisfy it.
          if (landingDecision.hold || !isSatisfiedSlotCollectionStep(routine, step, variables)) {
            traceSteps.push({ ...landingEntry, event: "rendered" });
            break;
          }

          // Satisfied and moved on: take that exit. Satisfied but stayed: the step's own
          // structure decides — never ask the selector twice about the same step.
          const landingNextId = landingDecision.nextStepId === step.id
            ? structuralExit(step, landingEdges, variables)
            : landingStepId(step.id, landingDecision);
          if (landingNextId === undefined || fastForwarded.has(landingNextId)) {
            traceSteps.push({ ...landingEntry, event: "rendered" });
            break;
          }
          traceSteps.push(landingEntry);
          step = stepById(landingNextId);
          fastForwarded.add(step.id);
          enterStep(step, path);
          continue;
        }

        const stepEdges = outgoing(step.id);
        if (stepEdges.length === 0) {
          break;
        }

        let fastForwardEntry: RoutineTraceStepEntry = { stepId: step.id, kind: step.kind, event: "fast_forwarded" };
        const decidedExit = structuralExit(step, stepEdges, variables);
        let nextStepId: string;
        if (decidedExit !== undefined) {
          nextStepId = decidedExit;
        } else if (afterTransit || !stepEdges.some(isLlmTransition)) {
          // Rule exits that don't match and no default, or only an AI-decides exit after a
          // transit step: nothing moves this step on.
          break;
        } else {
          const fastForwardState: RoutineState = { ...state, path, variables, attempts, status: "active" };
          const beforeFastForward = variables;
          const fastForwardDecision = await selectNext({
            step,
            transitions: stepEdges,
            variables,
            state: fastForwardState,
          });
          if (fastForwardDecision.yieldTurn) {
            return true;
          }
          fastForwardEntry = selectorEntry(step, beforeFastForward, fastForwardDecision);
          variables = { ...variables, ...(fastForwardDecision.variables ?? {}) };
          nextStepId = landingStepId(step.id, fastForwardDecision);
          if (nextStepId === step.id) {
            // The step stays — held, or nothing chosen — so it is the one this turn renders;
            // record it with what its selector returned.
            traceSteps.push({ ...fastForwardEntry, event: "rendered" });
            break;
          }
        }

        // Would re-enter a step already visited this traversal (a loop). Render the step
        // we're on rather than chasing the cycle. Break BEFORE recording the skip: this
        // step is about to be rendered, not skipped, so labelling it `fast_forwarded`
        // would make the debug panel show the step the user replied from as "Skipped".
        if (fastForwarded.has(nextStepId)) {
          break;
        }
        traceSteps.push(fastForwardEntry);
        step = stepById(nextStepId);
        fastForwarded.add(step.id);
        enterStep(step, path);
      }
      return false;
    };
    if (await fastForward({ afterTransit: false })) {
      return yieldTurn();
    }
    // A step a transit step lands on is walked too (#1390): skipped when it already holds its
    // values and a rule or default exit moves it, and on the activation turn read for the
    // opening message. Only on its first entry this turn, so the walk never re-enters a step it
    // passed or a tool step that already ran. This walk asks the selector only for the
    // activation-turn read, which lands rather than yields, so it never yields the turn.
    const fastForwardTransitLanding = async (): Promise<void> => {
      if (fastForwarded.has(step.id)) {
        return;
      }
      fastForwarded.add(step.id);
      await fastForward({ afterTransit: true });
    };

    // Bound how often one step is asked again with nothing new captured (#1376). Past the
    // limit the reply is told to ask differently. The routine never takes an authored exit by
    // itself: one to a hand-off end can be the step's confirmation edge, and taking it would
    // submit what the visitor never confirmed.
    const reasked = !input.activationTurn &&
      currentStep.kind === "chat" &&
      step.id === currentStepId &&
      path.length === state.path.length;
    const reaskCount = reasked && !filledCollectedSlot(currentStep, state.variables, variables)
      ? (state.reaskCount ?? 0) + 1
      : 0;
    const reaskLimit = this.options.reaskLimit ?? DEFAULT_REASK_LIMIT;
    // Still stuck after asking differently, on a routine whose author hands visitors to a
    // person: the run ends `stuck` on this step instead (#1384). It enters no terminal step: the
    // hand-off end's message and the completion export run only for a visitor who reaches it.
    if (reaskCount > reaskLimit + ASK_DIFFERENTLY_TURNS_BEFORE_HANDOFF && routesToHandoff(routine)) {
      traceSteps.push({ stepId: currentStep.id, kind: currentStep.kind, event: "reask_limit_handoff", reaskCount });
      return {
        kind: "claimed",
        effects: {
          nextState: null,
          terminal: { kind: "stuck", stepId: currentStep.id, collected: declaredSlotVariables(routine, variables) },
          trace: {
            routineId: routine.id,
            startStepId: currentStepId,
            landedStepId: currentStep.id,
            terminalKind: "stuck",
            capturedSlotKeys: [...new Set(traceSteps.flatMap((entry) => entry.capturedSlotKeys ?? []))],
            filledSlotKeys: [...declaredSlotKeys].filter((key) => hasVariable(variables, key)),
            ...slotValuesTraceFields(routine, variables, this.options.includeSlotValues),
            steps: traceSteps,
          },
        },
        reply: this.prepareReply({ step: currentStep, steering: [], turn, stuckHandoff: true }),
      };
    }
    const reaskExhausted = reaskCount > reaskLimit;
    if (reaskExhausted) {
      traceSteps.push({ stepId: currentStep.id, kind: currentStep.kind, event: "reask_limit_reached", reaskCount });
    }

    // Run through any transit steps — skill (dispatch a tool) and action (emit a
    // fire-and-forget request) — advancing off each this turn, until a chat/terminal
    // step renders. Bounded by the routine's step count so a misauthored cycle fails
    // loudly instead of looping (and re-firing a side effect) forever. Neither kind is
    // ever left as the resume position.
    const actions: RoutineActionRequest[] = [];
    // Every skill a skill step runs on the way that may already have acted outside the
    // conversation, so the host learns of it before the turn is saved. Only the dispatcher
    // knows what a skill does; one that does not say it stayed inside counts.
    const skillsWithExternalEffects: string[] = [];
    let hops = 0;
    while (step.kind === "skill" || step.kind === "action") {
      if (++hops > routine.steps.length) {
        throw new Error(`routine_walk_exceeded:${routine.id}:${step.id}`);
      }

      if (step.kind === "action") {
        if (!step.actionType) {
          throw new Error(`routine_action_step_missing_type:${routine.id}:${step.id}`);
        }
        const actionEdges = outgoing(step.id);
        if (actionEdges.length === 0) {
          throw new Error(`routine_action_step_no_follow_up:${routine.id}:${step.id}`);
        }
        // Fire-and-forget: record the request (authored type + the routine's variables)
        // and auto-advance — there is no result to branch on.
        actions.push({ type: step.actionType, payload: { ...variables } });
        traceSteps.push({
          stepId: step.id,
          kind: step.kind,
          event: "action_emitted",
          ...(pendingRootRejected.length > 0 ? { rejectedSlots: pendingRootRejected } : {}),
        });
        pendingRootRejected = [];
        step = stepById(actionEdges[0].to);
        enterStep(step, path);
        await fastForwardTransitLanding();
        continue;
      }

      // skill step: dispatch, then advance off it.
      if (!this.skillDispatcher) {
        throw new Error(`routine_skill_dispatcher_missing:${routine.id}:${step.id}`);
      }
      if (!step.skillName) {
        throw new Error(`routine_skill_step_missing_skill:${routine.id}:${step.id}`);
      }
      const skillStateAtStep: RoutineState = { ...state, path, variables, attempts, status: "active" };
      const skillResult: RoutineSkillResult = await this.skillDispatcher.dispatch({
        skillName: step.skillName,
        state: skillStateAtStep,
        turn: stagedContext === turn.stagedContext ? turn : { ...turn, stagedContext },
        ...(step.inputBindings ? { inputBindings: step.inputBindings } : {}),
      });
      if (skillResult.actsOutsideConversation !== false) {
        skillsWithExternalEffects.push(step.skillName);
      }
      variables = { ...variables, ...assignOutputs(step.outputAssignments, skillResult.outputs) };
      const staged = stagedContextForSkillResult(step, skillResult);
      if (staged) {
        stagedContext = [...stagedContext, staged];
      }
      const skillReason = typeof skillResult.metadata?.failureReason === "string"
        ? skillResult.metadata.failureReason
        : undefined;
      const skillEntry: RoutineTraceStepEntry = {
        stepId: step.id,
        kind: step.kind,
        event: "skill_dispatched",
        ...(step.skillName ? { skillName: step.skillName } : {}),
        skillStatus: skillResult.status,
        ...(skillReason ? { skillReason } : {}),
        ...(pendingRootRejected.length > 0 ? { rejectedSlots: pendingRootRejected } : {}),
      };
      pendingRootRejected = [];
      traceSteps.push(skillEntry);
      const skillEdges = outgoing(step.id);
      if (skillEdges.length === 0) {
        throw new Error(`routine_skill_step_no_follow_up:${routine.id}:${step.id}`);
      }
      let nextStepId: string;
      if (skillEdges.length === 1 && isLlmTransition(skillEdges[0])) {
        // Legacy single follow-up → deterministic auto-advance, no selector call.
        nextStepId = skillEdges[0].to;
      } else {
        const beforeSkill = variables;
        const skillDecision = await selectNext({
          step,
          transitions: skillEdges,
          variables,
          state: { ...skillStateAtStep, variables },
          skillResult,
          defaultOnDecline: true,
        });
        if (lastSelectorRan) {
          skillEntry.viaSelector = true;
        }
        if (lastSelection) {
          skillEntry.selection = lastSelection;
        }
        const capturedAtSkill = capturedKeysFrom(beforeSkill, skillDecision);
        if (capturedAtSkill.length > 0) {
          skillEntry.capturedSlotKeys = capturedAtSkill;
        }
        if (lastRejectedSlots.length > 0) {
          skillEntry.rejectedSlots = [...(skillEntry.rejectedSlots ?? []), ...lastRejectedSlots];
        }
        variables = { ...variables, ...(skillDecision.variables ?? {}) };
        const chosen = landingStepId(step.id, skillDecision);
        // The tool step can't be held (holding would re-run the tool), so a selector that
        // leaves it parked here — a decline, or an off-topic yield (#1383) — advances
        // instead. A decline with a default edge already resolves to that default inside
        // selectNextRaw, so this only still sees `chosen === step.id` for: a decline with
        // no default (first edge, as before), or any off-topic yield, which bypasses that
        // resolution entirely and must be checked for a default here too.
        if (chosen === step.id) {
          const skillDefault = skillEdges.find(isDefaultTransition);
          if (skillDefault) {
            nextStepId = skillDefault.to;
          } else if (skillEdges.some(isLlmTransition)) {
            nextStepId = skillEdges[0].to;
          } else {
            throw new Error(`routine_skill_step_no_matching_follow_up:${routine.id}:${step.id}:${skillResult.status}`);
          }
        } else {
          nextStepId = chosen;
        }
      }
      step = stepById(nextStepId);
      enterStep(step, path);
      await fastForwardTransitLanding();
    }

    if (step.kind === "await") {
      if (!step.decision) {
        throw new Error(`routine_await_step_missing_decision:${routine.id}:${step.id}`);
      }
      const nextState: RoutineState = { ...stateWithoutReaskCount, path, variables, attempts, status: "suspended" };
      const renderedStep = step.action
        ? { ...step, action: resolveStepAction(step.action, variables, stagedContext, this.options.contextRenderer) }
        : step;
      const baseSteering = projectStep(renderedStep);
      const steering = input.steeringResolver
        ? await input.steeringResolver.resolve({ step, baseSteering, turn })
        : baseSteering;
      const reply = this.prepareReply({
        step: renderedStep,
        steering,
        turn,
      });
      traceSteps.push({ stepId: step.id, kind: step.kind, event: "suspended" });
      const trace: RoutineRunTrace = {
        routineId: routine.id,
        startStepId: currentStepId,
        landedStepId: step.id,
        capturedSlotKeys: [...new Set(traceSteps.flatMap((entry) => entry.capturedSlotKeys ?? []))],
        filledSlotKeys: [...declaredSlotKeys].filter((key) => hasVariable(variables, key)),
        ...slotValuesTraceFields(routine, variables, this.options.includeSlotValues),
        steps: traceSteps,
      };
      const reason = typeof step.metadata?.reason === "string" ? step.metadata.reason : undefined;

      return {
        kind: "claimed",
        effects: {
          nextState,
          awaitingDecision: {
            stepId: step.id,
            options: step.decision.options,
            captureKey: step.decision.captureKey,
            ...(reason ? { reason } : {}),
          },
          ...(actions.length > 0 ? { actions } : {}),
          ...(skillsWithExternalEffects.length > 0 ? { skillsWithExternalEffects } : {}),
          trace,
        },
        reply,
      };
    }

    const nextState: RoutineState = {
      ...stateWithoutReaskCount,
      path,
      variables,
      attempts,
      status: "active",
      ...(reaskCount > 0 ? { reaskCount } : {}),
    };
    // Fill the captured slot values and referenced context into the step's instruction
    // before it reaches the renderer, so "{{slot.phone}}" renders the real value and
    // "{{context.page_context}}" the host's rendering of the visitor's page.
    const renderedStep = step.action
      ? { ...step, action: resolveStepAction(step.action, variables, stagedContext, this.options.contextRenderer) }
      : step;
    const turnWithStagedContext: TurnContext = stagedContext === turn.stagedContext
      ? turn
      : { ...turn, stagedContext };
    const baseSteering = projectStep(renderedStep);
    const steering = input.steeringResolver
      ? await input.steeringResolver.resolve({ step, baseSteering, turn: turnWithStagedContext })
      : baseSteering;

    // Rendering the chat step the user was answering means their reply did not satisfy
    // it. The renderer must know, or it reads a bare "yes" to a confirmation question as
    // the flow being done (#1369). On the activation turn the step is asked for the first time.
    const missing =
      !input.activationTurn && step.kind === "chat" && step.id === currentStepId
        ? reaskFor(routine, step, variables, rejectedCollectedKeys(step, resumeStepRejected))
        : null;
    // Past the re-ask limit the renderer is always told, even when the step holds its slots.
    const reask: RoutineStepReask | null = reaskExhausted
      ? { ...(missing ?? { missingSlots: [] }), exhausted: true }
      : missing;
    const reply = this.prepareReply({
      step: renderedStep,
      steering,
      turn: turnWithStagedContext,
      ...(reask ? { reask } : {}),
    });

    const terminalKind = terminalKindFor(step);
    const completionExportAction = completionExportActionFor(routine, step, terminalKind, variables);
    if (completionExportAction) {
      actions.push(completionExportAction);
    }

    // Mark the step the turn replied from — unless it already has the last entry this
    // turn (a re-ask renders the very step it stayed on), which would list it twice.
    const lastTraceEntry = traceSteps[traceSteps.length - 1];
    if (!lastTraceEntry || lastTraceEntry.stepId !== step.id) {
      traceSteps.push({ stepId: step.id, kind: step.kind, event: "rendered" });
    }
    const trace: RoutineRunTrace = {
      routineId: routine.id,
      startStepId: currentStepId,
      landedStepId: step.id,
      ...(terminalKind ? { terminalKind } : {}),
      capturedSlotKeys: [...new Set(traceSteps.flatMap((entry) => entry.capturedSlotKeys ?? []))],
      filledSlotKeys: [...declaredSlotKeys].filter((key) => hasVariable(variables, key)),
      ...slotValuesTraceFields(routine, variables, this.options.includeSlotValues),
      steps: traceSteps,
    };

    return {
      kind: "claimed",
      effects: {
        // A terminal step ends the routine — clear its state.
        nextState: step.kind === "terminal" ? null : nextState,
        ...(terminalKind
          ? { terminal: terminalResult(terminalKind, step, declaredSlotVariables(routine, variables)) }
          : {}),
        ...(actions.length > 0 ? { actions } : {}),
        ...(skillsWithExternalEffects.length > 0 ? { skillsWithExternalEffects } : {}),
        trace,
      },
      reply,
    };
  }
}
