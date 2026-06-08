export type ConversationRole = "system" | "user" | "assistant" | "tool";

export interface ConversationMessage {
  id?: string;
  role: ConversationRole;
  content: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationAgentConfig {
  id: string;
  name?: string;
  instructions?: string[];
  defaultLocale?: string | null;
  model?: ConversationModelPreference | null;
  metadata?: Record<string, unknown>;
}

export interface ConversationModelPreference {
  provider?: string;
  model?: string;
}

export interface ConversationInputEvent {
  id?: string;
  kind: string;
  content: string;
  locale?: string | null;
  metadata?: Record<string, unknown>;
}

export type SteeringSource = "directive" | "skill" | "routine";

export type SteeringLifespan = "response" | "session";

export interface SteeringRule {
  action: string;
  condition?: string;
  priority?: number;
  description?: string;
  source: SteeringSource;
  lifespan: SteeringLifespan;
}

export type SkillTransientGuidance = Omit<SteeringRule, "source" | "lifespan">;

export interface RenderInstruction {
  instruction: string;
  source?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface Directive {
  id?: string;
  name: string;
  condition: DirectiveCondition;
  action: string;
  priority?: number;
  requiredCapabilities?: string[];
  dependsOn?: string[];
  excludes?: string[];
  description?: string;
  metadata?: Record<string, unknown>;
}

export type DirectiveCondition =
  | { kind: "always" }
  | { kind: "contextual"; description: string };

export type DirectiveSelectionMode = "deterministic" | "probabilistic";

export interface DirectiveMatch {
  directive: Directive;
  selectionMode: DirectiveSelectionMode;
  selectionReason: string;
  selectionConfidence?: number;
}

export interface SkillDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  outcomeKinds?: string[];
  metadata?: Record<string, unknown>;
}

export type SkillOutcomeStatus =
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "awaiting_confirmation"
  | "awaiting_tool"
  | "cancelled"
  | "expired";

export interface SkillOutcomeControl {
  sessionMode?: "automatic" | "manual";
  lifespan?: "response" | "session";
}

export interface SkillOutcome {
  status: SkillOutcomeStatus;
  answer?: string;
  outputs?: Record<string, unknown>;
  control?: SkillOutcomeControl;
  guidance?: SkillTransientGuidance[];
  metadata?: Record<string, unknown>;
  error?: SkillOutcomeError;
}

export interface SkillOutcomeError {
  code: string;
  message: string;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface StagedContext {
  kind: string;
  id?: string;
  data: unknown;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface TurnContext {
  agent: ConversationAgentConfig;
  sessionId: string;
  inputEvent: ConversationInputEvent;
  history: ConversationMessage[];
  stagedContext: StagedContext[];
  steering: SteeringRule[];
  activeRoutineId?: string;
  activeStepId?: string;
  metadata?: Record<string, unknown>;
}

export interface SelectedSkill {
  skillName: string;
  input?: unknown;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface SelectionDecision {
  selected: SelectedSkill[];
  considered?: SkillSelectionConsideration[];
  steeringConsidered?: SteeringRule[];
  reason?: string;
}

export interface SkillSelectionConsideration {
  skillName: string;
  selected: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface TurnOutcome {
  kind: string;
  skillName: string;
  outcome: SkillOutcome;
  stagedContext: StagedContext[];
  steering: SteeringRule[];
  trace: ConversationTrace;
  /**
   * Optional capability sub-trace the engine copies onto the dispatch stage for
   * this skill. Capabilities whose domain trace is ready at dispatch time set it
   * here; capabilities finalized later (e.g. retrieval) attach it downstream.
   */
  subTrace?: CapabilitySubTrace;
}

export interface RenderableTurn {
  answer: string;
  citations?: unknown[];
  suggestions?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface TurnStreamDelta {
  type: "delta";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface TurnStreamFinal {
  type: "final";
  response: RenderableTurn;
  metadata?: Record<string, unknown>;
}

export type TurnStreamEvent = TurnStreamDelta | TurnStreamFinal;

export interface ConversationTrace {
  traceId: string;
  startedAt: string;
  completedAt?: string;
  stages: ConversationTraceStage[];
  links?: ConversationTraceLink[];
  summary?: Record<string, unknown>;
}

export interface ConversationTraceStage {
  id: string;
  kind: string;
  status: "applied" | "skipped" | "fallback" | "rejected" | "unavailable" | "failed";
  startedAt?: string;
  completedAt?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  metrics?: Record<string, number>;
  /**
   * A capability's own domain trace, hung off the dispatch stage that ran it.
   * Opaque to the engine: it is copied through verbatim and never inspected.
   * The renderer dispatches on `namespace` to a per-capability detail view.
   */
  subTrace?: CapabilitySubTrace;
}

/**
 * A namespaced, versioned sub-trace produced by a capability (e.g. retrieval).
 * The conversation spine carries it opaquely so the generic engine stays
 * ignorant of any capability-specific trace shape.
 */
export interface CapabilitySubTrace {
  namespace: string;
  version: number;
  payload: unknown;
}

export interface ConversationTraceLink {
  from: string;
  to: string;
  kind: string;
}

/**
 * The turn's read/write ports for conversation state.
 *
 * **Persistence is a captured command, not a guaranteed write.** The engine calls
 * `appendEvent` (and, via {@link ConversationRoutineStore}, `save`/`clear`) as it runs,
 * as if it owned persistence — but the host decides what those calls actually do. A host
 * that persists the turn another way may make `appendEvent` a no-op (Radioso records the
 * turn as assistant-message metadata, not as event rows), and may *capture* routine
 * `save`/`clear` to commit them transactionally with other turn effects (e.g. an action
 * outbox) rather than writing immediately. So treat these as effects the engine *emits*;
 * whether/when they hit storage is the host's call.
 */
export interface ConversationStores {
  loadHistory(input: { sessionId: string; limit?: number }): Promise<ConversationMessage[]>;
  appendEvent(event: ConversationEvent): Promise<void>;
}

export interface ConversationEvent {
  id?: string;
  sessionId: string;
  kind: string;
  role?: ConversationRole;
  content?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface ConversationModelGateway {
  complete(input: {
    messages: ConversationMessage[];
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ text: string; metadata?: Record<string, unknown> }>;
}

export interface ConversationSkillDispatcher {
  dispatch(input: {
    skill: SkillDefinition;
    turn: TurnContext;
    selected: SelectedSkill;
  }): Promise<TurnOutcome>;
}

export interface ConversationDirectiveMatcher {
  match(input: { turn: TurnContext; directives: Directive[] }): Promise<DirectiveMatch[]>;
}

export interface SteeringResolver {
  resolve(rules: SteeringRule[], ctx: { turnContext: TurnContext }): SteeringRule[];
}

export interface ConversationSkillSelector {
  select(input: {
    turn: TurnContext;
    skills: SkillDefinition[];
    directives: DirectiveMatch[];
  }): Promise<SelectionDecision>;
}

export interface ConversationTurnComposeInput {
  turn: TurnContext;
  outcomes: TurnOutcome[];
  decision: SelectionDecision;
}

export interface ConversationTurnComposer {
  compose(input: ConversationTurnComposeInput): Promise<RenderableTurn>;
}

export interface ConversationTurnStreamComposer extends ConversationTurnComposer {
  stream(input: ConversationTurnComposeInput): AsyncIterable<TurnStreamEvent>;
}

/**
 * A session's position in an in-flight Routine (a stateful, multi-step flow).
 * `path` is the node-index history (last element is the current step); `variables`
 * holds captured slots. The engine persists this between turns and resumes from it.
 */
export interface RoutineState {
  sessionId: string;
  routineId: string;
  path: string[];
  variables: Record<string, unknown>;
  status: "active" | "completed" | "expired";
  metadata?: Record<string, unknown>;
}

/**
 * A Routine is an authored graph of steps connected by conditional transitions.
 * A `chat` step's `action` is projected into a steering rule (it steers the reply);
 * a `skill` step dispatches `skillName`; a `terminal` step ends the routine.
 */
export interface RoutineStep {
  id: string;
  kind: "chat" | "skill" | "action" | "terminal";
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
  metadata?: Record<string, unknown>;
}

/** A fire-and-forget side effect a routine requested: an authored `type` + payload. */
export interface RoutineActionRequest {
  type: string;
  payload: Record<string, unknown>;
}

export interface RoutineTransition {
  from: string;
  to: string;
  /** Condition the next-step selector evaluates to decide whether this edge fires. */
  condition: string;
}

export interface Routine {
  id: string;
  rootStepId: string;
  steps: RoutineStep[];
  transitions: RoutineTransition[];
  metadata?: Record<string, unknown>;
}

export interface RoutineNextStepDecision {
  /**
   * The chosen step id. It MUST be either an outgoing transition's target or the
   * current step id (the reserved "stay / re-ask" sentinel) — the runner constrains
   * the choice to declared successors and treats anything else as staying put, so a
   * self-transition (`from === to`) cannot model an advance.
   */
  nextStepId: string;
  /** Variables captured this turn (merged into routine state). */
  variables?: Record<string, unknown>;
  /**
   * When true, the routine declines this turn: the user's message is off-topic for
   * the routine (e.g. a question that merely mentions a value being collected), so it
   * is yielded to normal answering and the routine stays at its current step to
   * resume later. Distinct from staying put to re-ask (which still answers in-routine).
   */
  yieldTurn?: boolean;
  rationale?: string;
}

/** The result of dispatching a Routine skill (tool) step. */
export interface RoutineSkillResult {
  status: SkillOutcomeStatus;
  outputs?: Record<string, unknown>;
  answer?: string;
}

/**
 * Dispatches a Routine skill (tool) step's skill. The host implements it over the
 * existing skill-executor registry; the runner advances past the step on its result.
 */
export interface ConversationRoutineSkillDispatcher {
  dispatch(input: {
    skillName: string;
    state: RoutineState;
    turn: TurnContext;
  }): Promise<RoutineSkillResult>;
}

/**
 * Advances an active Routine: given the current step and its outgoing transitions,
 * decide which step the turn lands on and capture any slot variables. Slice 3
 * provides the LLM implementation; the runner consumes it through this port. When a
 * skill step just ran, its `skillResult` is passed so the selector can read the
 * outcome (e.g. to choose a success vs. failure edge).
 */
export interface ConversationRoutineNextStepSelector {
  select(input: {
    routine: Routine;
    state: RoutineState;
    currentStep: RoutineStep;
    transitions: RoutineTransition[];
    turn: TurnContext;
    skillResult?: RoutineSkillResult;
  }): Promise<RoutineNextStepDecision>;
}

/**
 * Renders the reply for the routine's current step. The host implements this with
 * the Radioso composer (the projected step steering is passed in), so the pure
 * engine owns graph mechanics and the host owns generation/presentation. It is told
 * only what it needs to write the message — the step and its projected steering for
 * this turn — not the graph topology or slot state.
 */
export interface ConversationRoutineStepRenderer {
  render(input: {
    step: RoutineStep;
    steering: SteeringRule[];
    turn: TurnContext;
  }): Promise<RenderableTurn>;
}

export interface ConversationRoutineSteeringInput {
  step: RoutineStep;
  baseSteering: SteeringRule[];
  turn: TurnContext;
}

export interface ConversationRoutineSteeringResolver {
  resolve(input: ConversationRoutineSteeringInput): Promise<SteeringRule[]>;
}

/**
 * Durable, session-scoped store for the active Routine's position + variables.
 * `loadActive` returns only an in-flight (`status: "active"`) routine — the store
 * owns expiry/TTL (clearing or expiring stale rows), so the engine never resumes a
 * completed or expired routine.
 */
export interface ConversationRoutineStore {
  loadActive(input: { sessionId: string }): Promise<RoutineState | null>;
  save(state: RoutineState): Promise<void>;
  clear(input: { sessionId: string }): Promise<void>;
}

export interface ConversationRoutineResumeResult {
  response: RenderableTurn;
  /** The next state to persist; `null` clears it (the routine reached a terminal step). */
  nextState: RoutineState | null;
  outcomes?: TurnOutcome[];
  /** Fire-and-forget side effects the routine emitted this turn, for the host to persist. */
  actions?: RoutineActionRequest[];
  /**
   * When true, the routine *declined* this turn: the user's message was off-topic for
   * the routine, so the engine yields to normal answering and leaves the routine's
   * position unchanged (to resume later). `response`/`nextState` are ignored — the
   * runner returns inert placeholders.
   */
  yielded?: boolean;
}

/**
 * Advances an active Routine one step for the current turn. The runner is the seam
 * the declarative model + LLM progression (later slices) fill; the engine only
 * resumes through it and persists the returned next state.
 */
export interface ConversationRoutineRunner {
  resume(input: {
    turn: TurnContext;
    state: RoutineState;
    steeringResolver?: ConversationRoutineSteeringResolver;
  }): Promise<ConversationRoutineResumeResult>;
}

/**
 * Decides whether a Routine should *start* this turn (a trigger fired) when no
 * routine is active. Consulted before normal skill selection; returning null leaves
 * the turn to normal selection. The new routine begins at its root step.
 */
export interface ConversationRoutineActivator {
  activate(input: { turn: TurnContext }): Promise<{ routineId: string; variables?: Record<string, unknown> } | null>;
}

export interface ProcessTurnInput {
  agent: ConversationAgentConfig;
  sessionId: string;
  inputEvent: ConversationInputEvent;
  skills: SkillDefinition[];
  directives: Directive[];
  stores: ConversationStores;
  modelGateway: ConversationModelGateway;
  dispatcher: ConversationSkillDispatcher;
  directiveMatcher: ConversationDirectiveMatcher;
  steeringResolver?: SteeringResolver;
  selector: ConversationSkillSelector;
  composer: ConversationTurnComposer;
  /**
   * Routine machinery, all optional. `routineStore` + `routineRunner` travel together
   * (both required to resume an active routine; wiring one without the other is inert).
   * With `routineActivator` also wired, the engine may start a new routine when none
   * is active. Absent leaves turn behavior unchanged.
   */
  routineStore?: ConversationRoutineStore;
  routineRunner?: ConversationRoutineRunner;
  routineActivator?: ConversationRoutineActivator;
}

export interface ProcessTurnStreamInput extends Omit<ProcessTurnInput, "composer"> {
  composer: ConversationTurnStreamComposer;
}

/**
 * The inputs `attemptRoutine` actually uses. Routine resume/activation never runs
 * selection, dispatch, or composition, so it does not take those ports — the host
 * builds only this narrow shape (no stub selector/dispatcher/composer). `ProcessTurnInput`
 * is a structural superset, so `processTurn` can pass its own input straight through.
 */
export interface AttemptRoutineInput {
  agent: ConversationAgentConfig;
  sessionId: string;
  inputEvent: ConversationInputEvent;
  stores: ConversationStores;
  directives?: Directive[];
  directiveMatcher?: ConversationDirectiveMatcher;
  steeringResolver?: SteeringResolver;
  routineStore?: ConversationRoutineStore;
  routineRunner?: ConversationRoutineRunner;
  routineActivator?: ConversationRoutineActivator;
}

export interface ProcessTurnResult {
  sessionId: string;
  events: ConversationEvent[];
  decision: SelectionDecision;
  outcomes: TurnOutcome[];
  response: RenderableTurn;
  trace: ConversationTrace;
  /**
   * Fire-and-forget action requests a routine emitted this turn. The host persists
   * these to its outbox (transactionally with the turn) and a worker dispatches them;
   * the engine only declares them.
   */
  actions?: RoutineActionRequest[];
}

export type ProcessTurnStreamEvent =
  | {
      type: "delta";
      sessionId: string;
      text: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "final";
      result: ProcessTurnResult;
      metadata?: Record<string, unknown>;
    };

export interface ConversationEngine {
  processTurn(input: ProcessTurnInput): Promise<ProcessTurnResult>;
  processTurnStream(input: ProcessTurnStreamInput): AsyncIterable<ProcessTurnStreamEvent>;
  /**
   * Attempt to resume or activate a routine for this turn, without running normal
   * selection/dispatch/compose. Returns the routine's turn result when a routine claims
   * the turn, or null when no routine machinery is wired, none is active/activates, or
   * the active routine yields the turn (off-topic) — so the host can treat the routine
   * as a multi-turn skill selected before grounding, and only ground when it returns null.
   */
  attemptRoutine(input: AttemptRoutineInput): Promise<ProcessTurnResult | null>;
}
