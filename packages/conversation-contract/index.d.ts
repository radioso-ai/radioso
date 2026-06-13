/**
 * Contract note for clarification capability 085: this file now exposes the
 * generic clarification contracts and widens ConversationRoutineActivator to return
 * an activation/clarification union for routine activation clarification.
 */

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
  /**
   * Optional authored tags. Scope tags use `routine:<id>` and
   * `step:<routineId>:<stepId>` conventions: untagged directives are global,
   * routine tags apply only while that routine is active, and step tags apply
   * only while that routine and step are active. Non-scope tags are ignored by
   * scope eligibility and may carry other meaning.
   */
  tags?: string[];
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

export interface DirectiveMatchInput {
  /** Turn signals a matcher may inspect (query, history summary, etc.). */
  turnContext: Record<string, unknown>;
  directives: Directive[];
}

/**
 * Decides which authored Directives' conditions hold this turn. Sibling to skill
 * selection: it matches, it does not execute.
 */
export interface DirectiveMatcherPort {
  match(input: DirectiveMatchInput): Promise<DirectiveMatch[]>;
}

/** The model's verdict that a single directive's condition holds this turn. */
export interface DirectiveClassification {
  name: string;
  confidence: number;
  reason?: string;
}

/**
 * Classifies which contextual directives apply to a turn. Narrow port so the
 * matcher is testable with a stub and the LLM wiring stays a composition detail.
 */
export interface DirectiveMatchGateway {
  match(input: { turnContext: Record<string, unknown>; directives: Directive[] }): Promise<DirectiveClassification[]>;
}

export interface DirectiveCoherenceConflict {
  directiveId?: string;
  directiveName: string;
  reason: string;
}

export interface DirectiveCoherenceVerdict {
  coherent: boolean;
  conflicts: DirectiveCoherenceConflict[];
  rationale: string;
}

export interface DirectiveCoherenceCheckInput {
  agent: ConversationAgentConfig;
  candidate: Directive;
  existingDirectives: Directive[];
}

export interface DirectiveCoherenceChecker {
  check(input: DirectiveCoherenceCheckInput): Promise<DirectiveCoherenceVerdict>;
}

export interface DirectiveCatalogRegistryPort {
  list(): Directive[];
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

export type RoutineSkillOutcomeStatus = SkillOutcomeStatus | (string & {});

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

export interface SkillCatalogRegistryPort<Entry extends { name: string } = { name: string }> {
  list(): Entry[];
  get(name: string): Entry | null;
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

/**
 * A detector-supplied option for a generic clarification decision. The payload is
 * opaque to the Clarifier and is interpreted only by the originating surface.
 */
export interface ClarificationCandidate {
  id: string;
  label: string;
  description?: string;
  /** Ordinal confidence within this candidate set only; never compare across sets. */
  confidence: number;
  payload: unknown;
}

/** Per-surface policy for deciding whether candidates are clear enough to avoid asking. */
export interface ClarificationPolicy {
  /** Minimum confidence required for a candidate to remain in the decision set. */
  floor: number;
  /** Top-vs-runner-up gap that counts as a clear winner. */
  margin: number;
  /**
   * Inner ask boundary for the two-band policy. Values are expected to be less
   * than or equal to `margin`; when absent this defaults to `margin`, leaving an
   * empty soft-pick band and preserving the single-margin behavior.
   */
  askMargin?: number;
  /** Maximum number of candidates presented in a clarifying question. */
  maxOptions: number;
}

export type ClarificationAutoPickReason = "clear_margin" | "priority" | "suppressed" | "loop_guard";

/** Pure clarification decision returned by engine-layer policy evaluation. */
export type ClarificationDecision =
  | { kind: "auto_pick"; candidate: ClarificationCandidate; reason: ClarificationAutoPickReason }
  | { kind: "soft_pick"; candidate: ClarificationCandidate; alternatives: ClarificationCandidate[] }
  | { kind: "ask"; candidates: ClarificationCandidate[] }
  | { kind: "none" };

export interface RoutineActivationDecisionMetadata {
  consideredCandidates: ClarificationCandidate[];
  decision: ClarificationDecision;
  reason?: string;
  margin?: number;
}

export type PendingClarificationStatus = "pending" | "resolved" | "declined" | "expired";
export type PendingClarificationMode = "ask" | "offer";

/** Conversation-scoped pending clarification row, including the presented opaque candidates. */
export interface PendingClarification {
  sessionId: string;
  source: string;
  /** Originating user message; nulled by stores once the row leaves pending status. */
  originalQuery?: string;
  /** `offer` stores answer-first alternatives that may be accepted on the next turn. */
  mode?: PendingClarificationMode;
  candidates: ClarificationCandidate[];
  askedEventId?: string;
  status: PendingClarificationStatus;
  expiresAt: string | Date;
}

export type ClarificationClearOutcome = "resolved" | "declined" | "expired";

/** Durable port for the at-most-one pending clarification in a conversation. */
export interface ConversationClarificationStore {
  loadPending(input: { sessionId: string }): Promise<PendingClarification | null>;
  save(pending: PendingClarification): Promise<void>;
  clear(input: { sessionId: string; outcome?: ClarificationClearOutcome }): Promise<void>;
}

/**
 * Optional read-side companion for clarification stores. It lives with the store
 * port because hosts own persistence/indexing; the engine only consumes the
 * capability when a host provides it.
 */
export interface RecentClarificationReader {
  loadRecent(input: { sessionId: string }): Promise<PendingClarification | null>;
}

export type ClarificationReplyMapping =
  | { kind: "chosen"; id: string }
  | { kind: "declined" }
  | { kind: "unrelated" };

/** LLM-backed clarifier port for phrasing questions and mapping free-text replies. */
export interface ConversationClarifier {
  phraseQuestion(input: { candidates: ClarificationCandidate[]; turn: TurnContext }): Promise<string>;
  mapReply(input: { candidates: ClarificationCandidate[]; turn: TurnContext }): Promise<ClarificationReplyMapping>;
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
  /** Per-step entry counts, used by deterministic counter guards. */
  attempts?: Record<string, number>;
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
}

export type RoutineGuard =
  | { kind: "slot_filled"; slots: string[] }
  | { kind: "outcome"; status: RoutineSkillOutcomeStatus }
  | { kind: "counter"; limit: number }
  | { kind: "default" }
  | { kind: "llm" };

export type RoutineSlotType = "text" | "number" | "boolean" | "email" | "date";

export interface RoutineSlotSchema {
  id: string;
  key: string;
  type: RoutineSlotType;
  required: boolean;
  description?: string;
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
  status: RoutineSkillOutcomeStatus;
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
  /** Distinguishes terminal exits such as handoff from normal completion. */
  terminal?: { kind: "complete" | "handoff" | "action"; stepId: string };
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
  activate(input: {
    turn: TurnContext;
    loopGuardCandidateIds?: string[];
    suppressClarificationAsk?: boolean;
  }): Promise<
    | {
        kind: "activate";
        routineId: string;
        variables?: Record<string, unknown>;
        decisionMetadata?: RoutineActivationDecisionMetadata;
      }
    | { kind: "clarify"; candidates: ClarificationCandidate[] }
    | null
  >;
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
  clarifier?: ConversationClarifier;
  clarificationStore?: ConversationClarificationStore;
  loopGuardCandidateIds?: string[];
  suppressNewClarification?: boolean;
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
  clarifier?: ConversationClarifier;
  clarificationStore?: ConversationClarificationStore;
  loopGuardCandidateIds?: string[];
  suppressNewClarification?: boolean;
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
  /** True when a routine ended in a human handoff terminal. */
  handoff?: { routineId: string; stepId: string };
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
