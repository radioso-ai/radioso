import type {
  ConversationRoutineClaim,
  ConversationRoutineConsentPort,
  ConversationRoutineNextStepSelector,
  ConversationRoutineResumeInput,
  ConversationRoutineResumeResult,
  ConversationRoutineRunner,
  ConversationRoutineSkillDispatcher,
  ConversationRoutineStepRenderer,
  PendingRenderableTurn,
  Routine,
  RoutineActionRequest,
  RoutineConsent,
  RoutineContextRenderer,
  RoutineHostEffects,
  RoutineNextStepDecision,
  RoutineRunTrace,
  RoutineSelectionTrace,
  RoutineSkillResult,
  RoutineState,
  RoutineStep,
  RoutineStepReask,
  RoutineStepReplyInput,
  RoutineTerminalKind,
  RoutineTraceRejectedSlot,
  RoutineTraceStepEntry,
  RoutineTransition,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";
import {
  completionExportActionFor,
  maskedSlotKeys,
  routesToHandoff,
  terminalKindFor,
  terminalResult,
} from "./routineEnding.js";
import { RoutineConsentGate } from "./routineConsentGate.js";
import { evaluateFieldGuard } from "./routineFieldGuard.js";
import { filledCollectedSlot, pendingStepFor, reaskFor, rejectedCollectedKeys } from "./routineReask.js";
import {
  foldStepEntry,
  runSlotKeyFields,
  slotKeyChangesFor,
  slotValuesTraceFields,
  startStepSlotKeyFields, stepSlotKeyFields,
} from "./routineTraceSlots.js";
import {
  collectedSlotsForStep,
  isSlotCollectionStepSatisfied,
  slotFilledGuardPasses,
} from "./slotCollectionStep.js";
import {
  assignOutputs,
  checkDeclaredSlotValues,
  declaredSlotVariables,
  hasVariable,
  outboundVariables,
  sensitiveSlotKeys,
} from "./routineSlotValues.js";
import { stepForReply } from "./stepReferences.js";

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
 * Runner-local gate on top of the shared `isSlotCollectionStepSatisfied` rule: only a
 * chat step on a routine with a typed slot schema can be fast-forwarded past.
 */
const isSatisfiedSlotCollectionStep = (
  routine: Routine,
  step: RoutineStep,
  variables: Record<string, unknown>,
  waived: ReadonlySet<string>,
): boolean => {
  if (step.kind !== "chat" || !hasTypedSlotSchema(routine)) {
    return false;
  }
  return isSlotCollectionStepSatisfied(routine, step, variables, waived);
};

const isDefaultTransition = (transition: RoutineTransition): boolean =>
  transition.guard?.kind === "default";

const isLlmTransition = (transition: RoutineTransition): boolean =>
  !transition.guard || transition.guard.kind === "llm";

const isCompilerSlotGate = (transition: RoutineTransition): boolean =>
  transition.origin === "compiler_slot_gate" && isLlmTransition(transition);

const isAuthoredLlmExit = (transition: RoutineTransition): boolean =>
  isLlmTransition(transition) && !isCompilerSlotGate(transition);

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
  /**
   * Whether the message that opens a run can state slot values. Absent/true is a message
   * someone wrote, which the selector reads for them. A host sets false when that message is
   * a structured call rendered as text and the run starts with the call's input (a routine
   * invoked as a tool). On the activation turn the runner then keeps no value and no hold a
   * selector returns, and asks it nothing those values answer: no extraction-only read, no read
   * of the opening message for a later step, no compiler slot gate. A step the values satisfy
   * moves on by its structure, and the first chat step they leave unsatisfied is asked, whatever
   * its exits (#1563): one with a required slot empty, or, on a step that collects only optional
   * slots, any of those empty. An optional slot beside a required one therefore stays empty once
   * the required one has a value. An exit the author wrote leaving a satisfied step is still
   * judged by the selector; when it chooses none, the step's rule or default exit decides, and a
   * step with neither is asked. Every later turn, and a run resumed on this turn, reads its
   * message as a reply.
   */
  openingMessageStatesSlotValues?: boolean;
  /**
   * Asks and reads a routine's consents (#1544). Absent, no consent can be asked, so a routine
   * that reaches one takes its decline path and its covered slots stay empty.
   */
  consent?: ConversationRoutineConsentPort;
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

  /** The consents of the routine this runner runs as `routineId`; none for a routine it does not run. */
  consentsFor(routineId: string): readonly RoutineConsent[] {
    return this.routines.find((candidate) => candidate.id === routineId)?.consents ?? [];
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
    // What the conversation decided for the routine's consents: a covered slot takes no value
    // this turn unless its consent was granted before it (#1544).
    const consentGate = await RoutineConsentGate.open(routine, this.options.consent, turn);
    const isSatisfiedStep = (step: RoutineStep, variables: Record<string, unknown>): boolean =>
      isSatisfiedSlotCollectionStep(routine, step, variables, consentGate.waived);
    // The values a routine starts with — the activator's extraction, or what a re-entered run
    // carries — enter its state here, so they are checked like any selector's (#1374). A resumed
    // run keeps none for a covered slot whose grant was withdrawn.
    const startCheck = input.activationTurn ? checkDeclaredSlotValues(routine, input.state.variables, consentGate.blocked) : null;
    const startVariables = startCheck?.values ?? consentGate.withoutBlocked(input.state.variables);
    const state: RoutineState = startVariables === input.state.variables ? input.state : { ...input.state, variables: startVariables };
    // Whether this turn's message can state slot values: a resumed run never received the
    // input of a call that opens a run, so it reads the message as a reply.
    const messageStatesSlotValues = !input.activationTurn || this.options.openingMessageStatesSlotValues !== false;
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
      pendingStep: pendingStepFor(routine, currentStep, state.variables, consentGate.waived),
    });

    // Debug trace: a step-by-step log of this turn's traversal, surfaced to the panel.
    // Slot KEYS only — never the captured values (which may be PII).
    const declaredSlotKeys = new Set((routine.slots ?? []).map((slot) => slot.key));
    const traceSteps: RoutineTraceStepEntry[] = [];
    const slotKeyChanges = (before: Record<string, unknown>, decision?: { variables?: Record<string, unknown> }) =>
      slotKeyChangesFor(declaredSlotKeys, before, decision);
    // Set by `selectNext` each call: whether it consulted the LLM selector (vs taking a
    // default/structured-guard edge), and what the selector reported its model returned.
    // Read immediately after each awaited call.
    let lastSelectorRan = false;
    let lastSelection: RoutineSelectionTrace | undefined;
    // The slots whose returned value the last `selectNext` call did not store (#1374).
    let lastRejectedSlots: RoutineTraceRejectedSlot[] = [];
    // Whether a selector decision in the last `selectNext` call asked to hold its step (#1375),
    // and whether that call held it because no AI-decides exit could be judged (#1715).
    let lastSelectorHold = false;
    let lastUnjudgedHold = false;
    // Every selector call goes through here, so no selector implementation can store a value
    // that does not fit its slot's declared type.
    const selectChecked = async (
      selectInput: Parameters<ConversationRoutineNextStepSelector["select"]>[0],
    ): Promise<RoutineNextStepDecision> => {
      const decision = await this.selector.select(messageStatesSlotValues ? consentGate.withEarlierMessageSlots(selectInput) : { ...selectInput, messageStatesSlotValues });
      lastSelection = decision.selection;
      // A message that states no values is a structured call, not a visitor's reply: any value
      // the selector returns is one it read into the call, and an authority claim is the call's
      // shape mistaken for one. Only the exit it chose is kept; its selection still records what
      // it returned for the trace. On an authority claim the selector chose the current step, so
      // the step's rule or default exit decides, and a step with neither is asked.
      if (!messageStatesSlotValues) {
        const { variables: _readIntoTheMessage, hold: _readAsAClaim, ...exitOnly } = decision;
        return exitOnly;
      }
      lastSelectorHold = lastSelectorHold || decision.hold === true;
      if (!decision.variables) {
        return decision;
      }
      const checked = checkDeclaredSlotValues(routine, decision.variables, consentGate.blocked);
      lastRejectedSlots = [...lastRejectedSlots, ...checked.rejected];
      return { ...decision, variables: checked.values };
    };

    const attempts: Record<string, number> = { ...(state.attempts ?? {}) };
    // This is deliberately local to a runner traversal. A retry resumes the same saved
    // state and rebuilds the same sequence, while a bounded back edge receives a distinct
    // occurrence for each visit.
    const skillOccurrences = new Map<string, number>();
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
      // When the message states no values, nothing this turn can fill a slot the values the
      // run holds leave empty, so the step is asked before any exit is weighed: neither a
      // default or rule exit nor an exit the model judges carries the run past it.
      if (
        !messageStatesSlotValues &&
        collected.length > 0 &&
        !isSatisfiedStep(input.step, input.variables)
      ) {
        return { nextStepId: input.step.id };
      }
      let extracted: Record<string, unknown> = {};
      if (
        messageStatesSlotValues &&
        collected.length > 0 &&
        (input.alwaysExtract || collected.some((key) => !hasVariable(input.variables, key) && !consentGate.waived.has(key))) &&
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
      // A compiler slot gate asks only whether the step's slots hold values, and when the message
      // states none the step reaching here holds them: it moves on by its structure.
      if (!messageStatesSlotValues && llmTransitions.every(isCompilerSlotGate)) {
        return { nextStepId: satisfiedStepExit(input.step, input.transitions, variables) ?? input.step.id };
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
        const exit = isSatisfiedStep(input.step, withDecision)
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
      // would silently drop the activation, so land on the step and render it instead. A
      // decision turn answers an operator's decision, not the message, so it lands too.
      if (decision.yieldTurn && !input.activationTurn && !input.decisionTurn) {
        return decision;
      }
      const landed: RoutineNextStepDecision = decision.yieldTurn ? { nextStepId: selectInput.step.id } : decision;
      // The hold: the chat step stays and is asked again, whichever exit — AI-decides, rule,
      // or default — would otherwise have fired. The values that did fit are kept. It has three
      // reasons:
      // - an authority claim (#1375): the selector asked to hold the step because the message
      //   carries text posing as a system, operator, or assistant message. It holds any chat
      //   step the selector read the message for: the one the visitor answered, or one reached
      //   by skipping ahead;
      // - a rejected value (#1374): the visitor gave a value for one of the answered step's own
      //   slots that does not fit its type — to the selector this turn, or to the activator in
      //   the opening message with no valid replacement since — so the step is not answered.
      //   A rejected value for another step's slot is dropped and holds nothing;
      // - an unjudged exit (#1715): the selector could not read its decision, and the step has an
      //   AI-decides exit its author wrote. A rule or default exit means none of those held, which
      //   nothing judged, so values a slot-only reading kept must not take one.
      // A tool step's follow-up still leaves by its default after a decline, since holding
      // the tool step could run its tool again.
      lastUnjudgedHold = false;
      if (selectInput.defaultOnDecline) {
        return landed;
      }
      const rejected = selectInput.answeredStep
        ? [...lastRejectedSlots, ...unreplacedStartRejections({ ...selectInput.variables, ...(landed.variables ?? {}) })]
        : [];
      lastUnjudgedHold = landed.exitsUnjudged !== undefined && selectInput.transitions.some(isAuthoredLlmExit);
      const hold = lastSelectorHold || lastUnjudgedHold || rejectedCollectedKeys(selectInput.step, rejected).size > 0;
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
    // Whether `selectNext` held the step the visitor answered (see the hold there), and whether
    // its reply went unread: nothing read it, or it was held with its exits unjudged (#1715).
    let held = false;
    let replyUnread = false;
    // The trace entry for the step the turn started on, when its edges were judged.
    let startEntry: RoutineTraceStepEntry | undefined;
    if (currentStep.kind === "skill" || currentStep.kind === "action" || currentStep.kind === "consent") {
      // Transit steps execute when the routine lands on them. This matters for a
      // routine whose root step is a tool (for example retrieval.context): selecting
      // from its outgoing edges first would skip the tool entirely. A consent step the run
      // waits on reads the visitor's reply itself, below.
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
      const awaitsNewAnswer = isSatisfiedStep(currentStep, state.variables) &&
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
      replyUnread = decision.exitsUnjudged === "unread" || lastUnjudgedHold;
      const mainSelectorRan = lastSelectorRan;
      const mainSelection = lastSelection;
      const selectorRejected = lastRejectedSlots;
      const tracedRejected = [...(startCheck?.rejected ?? []), ...selectorRejected];
      const landedId = landingStepId(currentStepId, decision);
      step = landedId === currentStepId ? currentStep : stepById(landedId);
      variables = { ...state.variables, ...(decision.variables ?? {}) };
      resumeStepRejected = [...selectorRejected, ...unreplacedStartRejections(variables)];
      // Trace the resume step's outcome: it either advanced off (the user satisfied it) or
      // was re-asked. Captured keys, if any, belong to this step's edge evaluation. On the
      // routine's first turn the step read the opening message and was never asked, so
      // staying on it is its first ask, not a re-ask (#1450).
      {
        const stayed = step.id === currentStepId;
        startEntry = {
          stepId: currentStep.id,
          kind: currentStep.kind,
          event: stayed ? (input.activationTurn ? "rendered" : "reasked") : "advanced",
          ...startStepSlotKeyFields(slotKeyChanges(state.variables, decision), input.activationTurn),
          ...(tracedRejected.length > 0 ? { rejectedSlots: tracedRejected } : {}),
          viaSelector: mainSelectorRan,
          ...(mainSelection ? { selection: mainSelection } : {}),
          // A message that states no values is read only to judge an exit the author wrote.
          ...(input.activationTurn && (messageStatesSlotValues || mainSelectorRan) ? { readOpeningMessage: true } : {}),
        };
        traceSteps.push(startEntry);
      }
      // Append to the path only on a real advance; re-asking a step keeps it stable.
      path = step.id === currentStepId ? [...state.path] : [...state.path, step.id];
      if (step.id !== currentStepId) {
        attempts[step.id] = (attempts[step.id] ?? 0) + 1;
      }
    }
    let stagedContext = turn.stagedContext;
    // The turn as this walk has staged it: a skill step's output joins the context every
    // later step this turn dispatches, steers, or replies from.
    const turnWithStagedContext = (): TurnContext =>
      stagedContext === turn.stagedContext ? turn : { ...turn, stagedContext };

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
      Object.assign(entry, stepSlotKeyFields(slotKeyChanges(before, decision)));
      if (lastRejectedSlots.length > 0) {
        entry.rejectedSlots = lastRejectedSlots;
      }
      return entry;
    };
    // The walk starts on the step the turn stayed on, which can already hold its values: it
    // moves that step on after all, or renders it after asking its selector again. Its entry
    // then folds into the start's, so the step is listed once.
    const recordWalkedStep = (entry: RoutineTraceStepEntry): void => {
      if (startEntry && traceSteps.at(-1) === startEntry && entry.stepId === startEntry.stepId) {
        traceSteps[traceSteps.length - 1] = foldStepEntry(startEntry, entry);
        return;
      }
      traceSteps.push(entry);
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
        if (!isSatisfiedStep(step, variables)) {
          // Activation turn only (#1370): the message that starts the routine can state
          // values for a step further down the graph than the one it answers directly.
          // Read it once for the step the walk stops on here; a later reply answers the
          // step shown on screen, so this never runs past the first turn. The walk never
          // revisits a step (every advance below lands outside `fastForwarded`, and a step a
          // transit step lands on is walked only on its first entry), so nothing needs to
          // track which steps already had this read. A message that states no values has
          // none for this step either.
          if (
            !input.activationTurn ||
            !messageStatesSlotValues ||
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
          if (landingDecision.hold || !isSatisfiedStep(step, variables)) {
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
            recordWalkedStep({ ...fastForwardEntry, event: "rendered" });
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
        recordWalkedStep(fastForwardEntry);
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
    const actions: RoutineActionRequest[] = [];
    // Every skill a skill step runs on the way that may already have acted outside the
    // conversation, so the host learns of it before the turn is saved. Only the dispatcher
    // knows what a skill does; one that does not say it stayed inside counts.
    const skillsWithExternalEffects: string[] = [];
    // What the walk did beside its reply: the actions it emitted, the skills that may have acted
    // outside, and what the host records for it — consent events with `hostEffects` given.
    const walkEffects = (hostEffects: RoutineHostEffects = {}) => ({
      ...(actions.length > 0 ? { actions } : {}),
      ...(skillsWithExternalEffects.length > 0 ? { skillsWithExternalEffects } : {}),
      ...(consentGate.events.length > 0 ? { hostEffects: { ...hostEffects, consentEvents: [...consentGate.events] } }
        : Object.keys(hostEffects).length > 0 ? { hostEffects } : {}),
    });
    const runTrace = (landedStepId: string, terminalKind?: RoutineTerminalKind): RoutineRunTrace => ({
      routineId: routine.id,
      startStepId: currentStepId,
      landedStepId,
      ...(terminalKind ? { terminalKind } : {}),
      ...runSlotKeyFields(traceSteps),
      filledSlotKeys: [...declaredSlotKeys].filter((key) => hasVariable(variables, key)),
      ...slotValuesTraceFields(routine, variables, this.options.includeSlotValues),
      steps: traceSteps,
    });
    // The runner's own hand-off endings, on `onStep`: no terminal step runs, so neither the
    // hand-off end's message nor the completion export does; the reply says a person continues.
    const handOff = (kind: "stuck" | "consent_declined", onStep: RoutineStep): ConversationRoutineClaim => {
      const collected = declaredSlotVariables(routine, variables);
      return {
        kind: "claimed",
        effects: {
          nextState: null,
          terminal: { kind, stepId: onStep.id, collected, ...maskedSlotKeys(routine, collected) },
          endedVariables: variables,
          ...walkEffects(),
          trace: runTrace(onStep.id, kind),
        },
        reply: this.prepareReply({ step: onStep, steering: [], turn: turnWithStagedContext(), stuckHandoff: true }),
      };
    };
    // Still stuck after asking differently, on a routine whose author hands visitors to a
    // person: the run ends `stuck` on this step instead (#1384).
    if (reaskCount > reaskLimit + ASK_DIFFERENTLY_TURNS_BEFORE_HANDOFF && routesToHandoff(routine)) {
      traceSteps.push({ stepId: currentStep.id, kind: currentStep.kind, event: "reask_limit_handoff", reaskCount });
      return handOff("stuck", currentStep);
    }
    const reaskExhausted = reaskCount > reaskLimit;
    if (reaskExhausted) {
      traceSteps.push({ stepId: currentStep.id, kind: currentStep.kind, event: "reask_limit_reached", reaskCount });
    }

    // Run through any transit steps — skill (dispatch a tool), action (emit a fire-and-forget
    // request) and consent (ask before a covered slot) — advancing off each this turn, until a
    // chat/terminal step renders. Bounded by the routine's step count so a misauthored cycle
    // fails loudly instead of looping (and re-firing a side effect) forever. Only a consent
    // step waiting on the visitor's answer is ever left as the resume position.
    let hops = 0;
    while (step.kind === "skill" || step.kind === "action" || step.kind === "consent") {
      if (++hops > routine.steps.length) {
        throw new Error(`routine_walk_exceeded:${routine.id}:${step.id}`);
      }

      if (step.kind === "consent") {
        const answering = !input.activationTurn && step.id === currentStepId ? { reaskCount: state.reaskCount ?? 0 } : null;
        const { outcome, entry } = await consentGate.land(step, answering);
        traceSteps.push(pendingRootRejected.length > 0 ? { ...entry, rejectedSlots: pendingRootRejected } : entry);
        pendingRootRejected = [];
        if (outcome.kind === "handoff") {
          return handOff("consent_declined", step);
        }
        if (outcome.kind === "park") {
          const { reaskCount: parkedAsks } = outcome;
          return {
            kind: "claimed",
            effects: {
              nextState: { ...stateWithoutReaskCount, path, variables, attempts, status: "active", ...(parkedAsks > 0 ? { reaskCount: parkedAsks } : {}) },
              ...walkEffects(),
              trace: runTrace(step.id),
            },
            reply: outcome.reply,
          };
        }
        const consentExit = outgoing(step.id).find(isDefaultTransition) ?? outgoing(step.id)[0];
        if (!consentExit) {
          throw new Error(`routine_consent_step_no_follow_up:${routine.id}:${step.id}`);
        }
        // A collecting step the decline waived leaves by its rule or default exit. One whose only
        // way on is an exit a model judges stays and is asked; publishing refuses that step under
        // a `continue` consent (`consent_step_needs_default_exit`, #1544).
        step = stepById(consentExit.to);
        enterStep(step, path);
        await fastForwardTransitLanding();
        continue;
      }

      if (step.kind === "action") {
        if (!step.actionType) {
          throw new Error(`routine_action_step_missing_type:${routine.id}:${step.id}`);
        }
        const actionEdges = outgoing(step.id);
        if (actionEdges.length === 0) {
          throw new Error(`routine_action_step_no_follow_up:${routine.id}:${step.id}`);
        }
        // Fire-and-forget: record the request (authored type + the routine's variables, a
        // sensitive slot's masked) and auto-advance — there is no result to branch on.
        actions.push({ type: step.actionType, payload: outboundVariables(routine, variables) });
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
      const sensitiveKeys = sensitiveSlotKeys(routine);
      const occurrenceOrdinal = (skillOccurrences.get(step.id) ?? 0) + 1;
      skillOccurrences.set(step.id, occurrenceOrdinal);
      const skillResult: RoutineSkillResult = await this.skillDispatcher.dispatch({
        skillName: step.skillName,
        state: skillStateAtStep,
        turn: turnWithStagedContext(),
        ...(step.inputBindings ? { inputBindings: step.inputBindings } : {}),
        ...(sensitiveKeys.length > 0 ? { sensitiveSlotKeys: sensitiveKeys } : {}),
        stepId: step.id,
        occurrenceOrdinal,
        ...(input.skillDispatchIdempotencyScope
          ? {
              idempotencyKey: `${input.skillDispatchIdempotencyScope}:routine:${encodeURIComponent(routine.id)}:step:${encodeURIComponent(step.id)}:occurrence:${occurrenceOrdinal}`,
            }
          : {}),
      });
      if (skillResult.actsOutsideConversation !== false) {
        skillsWithExternalEffects.push(step.skillName);
      }
      const assigned = consentGate.admit(assignOutputs(step.outputAssignments, skillResult.outputs));
      variables = { ...variables, ...assigned.values };
      const skillRejected = [...pendingRootRejected, ...assigned.rejected];
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
        ...(skillRejected.length > 0 ? { rejectedSlots: skillRejected } : {}),
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
        Object.assign(skillEntry, stepSlotKeyFields(slotKeyChanges(beforeSkill, skillDecision)));
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
      const rendered = stepForReply(step, variables, stagedContext, this.options.contextRenderer);
      const replyTurn = turnWithStagedContext();
      const baseSteering = projectStep(rendered.step);
      const steering = input.steeringResolver
        ? await input.steeringResolver.resolve({ step, baseSteering, turn: replyTurn })
        : baseSteering;
      const reply = this.prepareReply({
        ...rendered,
        steering,
        turn: replyTurn,
      });
      traceSteps.push({ stepId: step.id, kind: step.kind, event: "suspended" });
      const reason = typeof step.metadata?.reason === "string" ? step.metadata.reason : undefined;

      return {
        kind: "claimed",
        effects: {
          nextState,
          ...walkEffects({
            awaitingDecision: {
              stepId: step.id,
              options: step.decision.options,
              captureKey: step.decision.captureKey,
              ...(reason ? { reason } : {}),
            },
          }),
          trace: runTrace(step.id),
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
    const rendered = stepForReply(step, variables, stagedContext, this.options.contextRenderer);
    const replyTurn = turnWithStagedContext();
    const baseSteering = projectStep(rendered.step);
    const steering = input.steeringResolver
      ? await input.steeringResolver.resolve({ step, baseSteering, turn: replyTurn })
      : baseSteering;

    // Rendering the chat step the user was answering means their reply did not satisfy
    // it, or could not be read. The renderer must know, or it reads a bare "yes" to a confirmation
    // question as the flow being done (#1369). On the activation turn the step is asked for the first time.
    const missing =
      !input.activationTurn && step.kind === "chat" && step.id === currentStepId
        ? reaskFor(routine, step, variables, rejectedCollectedKeys(step, resumeStepRejected), replyUnread, consentGate.waived)
        : null;
    // Past the re-ask limit the renderer is always told, even when the step holds its slots.
    const reask: RoutineStepReask | null = reaskExhausted
      ? { ...(missing ?? { missingSlots: [] }), exhausted: true }
      : missing;
    const reply = this.prepareReply({
      ...rendered,
      steering,
      turn: replyTurn,
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
    return {
      kind: "claimed",
      effects: {
        // A terminal step ends the routine — clear its state, and report the values it ended
        // with for the host's record of the ended run.
        ...(step.kind === "terminal" ? { nextState: null, endedVariables: variables } : { nextState }),
        ...(terminalKind
          ? { terminal: terminalResult(routine, terminalKind, step, declaredSlotVariables(routine, variables)) }
          : {}),
        ...walkEffects(),
        trace: runTrace(step.id, terminalKind ?? undefined),
      },
      reply,
    };
  }
}
