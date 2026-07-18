/**
 * Contract note for clarification capability 085: this file now exposes the
 * generic clarification contracts and widens ConversationRoutineActivator to return
 * an activation/clarification union for routine activation clarification.
 */

export type ConversationRole = "system" | "user" | "assistant" | "tool";

export type MessageSource =
  | "customer"
  | "ai_agent"
  | "human_agent"
  | "human_agent_on_behalf_of_ai_agent"
  | "system";

export interface ConversationMessage {
  id?: string;
  role: ConversationRole;
  content: string;
  source?: MessageSource;
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

export type ConversationChannelContext =
  | {
      provider: "slack";
      team: { id: string; name?: string };
      channel: { id: string; type: "im" | "channel" };
      threadTs?: string;
      user: { id: string; displayName?: string };
    }
  | {
      provider: "web";
      origin?: string;
    };

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
   * Optional authored routing target. The matcher never reads bindings; matching
   * continues to depend only on directive name and condition. `kind` is shaped as
   * a union so future targets such as `routine` can extend the contract without a
   * persistence migration.
   */
  binding?: DirectiveBinding | null;
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

export interface DirectiveBinding {
  kind: "skill";
  skillName: string;
}

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

/**
 * A source a renderer grounded an answer on, in a host-neutral shape. The kit produces
 * these from retrieval skill output it already holds; the host maps them to its own
 * citation type (resolving/validating a source URL from `metadata`) and sanitizes per
 * surface. IDs are optional because not every staged context carries them.
 */
export interface ConversationCitation {
  documentId?: string;
  chunkId?: string;
  title: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface RenderableTurn {
  answer: string;
  /** Sources the turn grounded on; carries {@link ConversationCitation}[] when present. */
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
  source?: MessageSource;
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

export interface ClarificationReplyMapInput {
  candidates: ClarificationCandidate[];
  turn: TurnContext;
  /**
   * Pending clarification mode. Omitted callers keep the historical blocking
   * clarification behavior; `offer` asks clarifiers to accept only selection-only
   * replies and treat substantive follow-up requests as unrelated.
   */
  mode?: PendingClarificationMode;
}

/** LLM-backed clarifier port for phrasing questions and mapping free-text replies. */
export interface ConversationClarifier {
  phraseQuestion(input: { candidates: ClarificationCandidate[]; turn: TurnContext }): Promise<string>;
  mapReply(input: ClarificationReplyMapInput): Promise<ClarificationReplyMapping>;
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

export type ConversationTurnRoute = "retrieval" | "direct";

export interface ConversationTurnInterpretation {
  route: ConversationTurnRoute;
  framing?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Host-owned structured turn interpretation. The engine owns when this runs and
 * which downstream ports it gates; the host owns model prompts and product
 * fields such as routing scope and retrieval rewrite metadata.
 */
export interface ConversationTurnInterpreter {
  interpret(input: { turn: TurnContext }): Promise<ConversationTurnInterpretation>;
}

export interface ConversationRetrievalWorkResult {
  stagedContext?: StagedContext[];
  steering?: SteeringRule[];
  trace?: ConversationTrace;
  subTrace?: CapabilitySubTrace;
  metadata?: Record<string, unknown>;
}

/**
 * Host-owned pre-answer retrieval work. The engine treats the payload opaquely
 * and invokes this port only when interpretation selected the retrieval route.
 */
export interface ConversationRetrievalWorkPort {
  run(input: {
    turn: TurnContext;
    interpretation: ConversationTurnInterpretation;
  }): Promise<ConversationRetrievalWorkResult>;
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
  status: "active" | "suspended" | "completed" | "expired";
  metadata?: Record<string, unknown>;
}

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  payload?: unknown;
}

export interface RoutineAwaitingDecision {
  stepId: string;
  options: DecisionOption[];
  captureKey: string;
  reason?: string;
}

export type RoutineInputBinding =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "variableRef"; ref: string }
  | { kind: "contextVariableRef"; contextVariable: string };

export type RoutineStepMode = "typed" | "untyped";

/**
 * A Routine is an authored graph of steps connected by conditional transitions.
 * A `chat` step's `action` is projected into a steering rule (it steers the reply);
 * a `skill` step dispatches `skillName`; a `terminal` step ends the routine.
 */
export interface RoutineStep {
  id: string;
  kind: "chat" | "skill" | "action" | "terminal" | "await";
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

export type RoutineSlotType = "text" | "number" | "boolean" | "email" | "date";

export interface RoutineSlotSchema {
  id: string;
  key: string;
  type: RoutineSlotType;
  required: boolean;
  description?: string;
  /** When true, the captured value may be corrected after the routine completes. */
  mutable?: boolean;
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
  /** Host-private dispatch metadata. Not rendered into routine prompts. */
  metadata?: Record<string, unknown>;
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
    inputBindings?: Record<string, RoutineInputBinding>;
    // Output→variable assignment is applied by the runner after dispatch (see
    // DefaultRoutineRunner), not by the dispatcher — so it is intentionally not
    // part of the dispatch input.
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
  loadCompleted?(input: { sessionId: string }): Promise<RoutineState[]>;
  save(state: RoutineState): Promise<void>;
  clear(input: { sessionId: string }): Promise<void>;
}

export interface SuspendedRoutineReader {
  loadSuspended(input: { sessionId: string }): Promise<RoutineState | null>;
}

/**
 * A detected post-completion slot correction (issue #746): the routine's declared slot
 * schema plus the slot the visitor wants to change and the proposed raw value. The host
 * resolves the routine (it owns the catalog) and runs model-driven, multilingual detection;
 * the engine then deterministically verifies via `verifySlotCorrection` before persisting.
 */
export interface RoutineSlotCorrectionCandidate {
  slots: RoutineSlotSchema[];
  slotKey: string;
  rawValue: string;
}

/**
 * Structured decision for a completed routine whose reentry mode is `semantic` (issue #746):
 * - `suppress`: leave the completed routine suppressed (the safe default for any non-semantic
 *   routine the gate is asked about, and for an unrelated message).
 * - `resume_existing`: re-open the same instance, keeping its captured variables.
 * - `start_new`: run the routine again from scratch, discarding the prior captured variables.
 */
export type RoutineReentryDecision =
  | { kind: "suppress" }
  | { kind: "resume_existing" }
  | { kind: "start_new" };

/**
 * Host port that decides whether a completed `semantic`-reentry routine should re-activate.
 * The host owns routine resolution + the model-driven decision; it returns `suppress` (no
 * model call) for any routine that is not in semantic mode, so the gate is inert unless an
 * author opted into it.
 */
export interface ConversationRoutineReentryGate {
  decide(input: { turn: TurnContext; completedState: RoutineState }): Promise<RoutineReentryDecision>;
}

/**
 * Host port for correcting a value captured by a routine that already completed, without
 * rerunning it. `detect` returns null when the latest message is not a correction (or the
 * completed routine has no mutable slots). `confirm` produces the user-facing reply — copy
 * comes from the model, never hard-coded in the engine.
 */
export interface ConversationRoutineSlotCorrection {
  detect(input: { turn: TurnContext; completedState: RoutineState }): Promise<RoutineSlotCorrectionCandidate | null>;
  confirm(input: {
    turn: TurnContext;
    routineId: string;
    slotKey: string;
    value: string | number | boolean;
  }): Promise<string>;
  /**
   * Reply when a detected correction's new value fails the slot's declared type — asks the
   * visitor for a valid value. Copy comes from the model; the engine persists nothing.
   */
  rejectInvalid(input: { turn: TurnContext; routineId: string; slotKey: string }): Promise<string>;
}

export interface RoutineDecisionInput {
  handle: string;
  optionId: string;
  payload?: unknown;
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
   * - `reasked`: stayed on the step because it isn't satisfied yet (a re-ask).
   * - `fast_forwarded`: a satisfied slot-collection step skipped without re-asking.
   * - `skill_dispatched`: a skill (tool) step ran.
   * - `action_emitted`: an action step emitted a fire-and-forget request.
   * - `rendered`: the step whose reply the turn rendered.
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
    | "decision_applied";
  /** Declared slot keys captured at this step this turn (names only — never values). */
  capturedSlotKeys?: string[];
  /** Whether the LLM next-step selector ran for this step's edges. */
  viaSelector?: boolean;
  skillName?: string;
  skillStatus?: string;
}

/**
 * A step-by-step record of one routine turn's traversal, surfaced to the debug panel
 * as a {@link CapabilitySubTrace} (`namespace: "routine"`). Names and structure only —
 * no slot values, prompts, or completions.
 */
export interface RoutineRunTrace {
  routineId: string;
  /** Step the turn resumed on. */
  startStepId: string;
  /** Step the turn ultimately rendered. */
  landedStepId: string;
  terminalKind?: "complete" | "handoff" | "action";
  /** Declared slot keys newly captured this turn (names only). */
  capturedSlotKeys: string[];
  /** Declared slot keys filled after this turn (names only). */
  filledSlotKeys: string[];
  steps: RoutineTraceStepEntry[];
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
   * The routine parked at an external decision gate. Mutually exclusive with terminal
   * exits and yielded turns; when present, `nextState.status === "suspended"`.
   */
  awaitingDecision?: RoutineAwaitingDecision;
  /** Step-by-step traversal record for the debug panel (omitted on a yield). */
  trace?: RoutineRunTrace;
  /**
   * When true, the routine *declined* this turn: the user's message was off-topic for
   * the routine, so the engine yields to normal answering and leaves the routine's
   * position unchanged (to resume later). `response`/`nextState` are ignored — the
   * runner returns inert placeholders.
   */
  yielded?: boolean;
}

export interface ConversationRoutineDecisionResult extends ConversationRoutineResumeResult {
  resumed: boolean;
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
    suppressedRoutineIds?: string[];
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
  turnInterpreter?: ConversationTurnInterpreter;
  retrievalWork?: ConversationRetrievalWorkPort;
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
  routineReentryGate?: ConversationRoutineReentryGate;
  routineSlotCorrection?: ConversationRoutineSlotCorrection;
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
  routineReentryGate?: ConversationRoutineReentryGate;
  routineSlotCorrection?: ConversationRoutineSlotCorrection;
  clarifier?: ConversationClarifier;
  clarificationStore?: ConversationClarificationStore;
  loopGuardCandidateIds?: string[];
  suppressNewClarification?: boolean;
}

export interface ResumeAwaitingDecisionInput {
  agent: ConversationAgentConfig;
  turn: TurnContext;
  sessionId: string;
  decision: RoutineDecisionInput;
  suspendedReader: SuspendedRoutineReader;
  routineStore?: ConversationRoutineStore;
  routineRunner: ConversationRoutineRunner;
  steeringResolver?: ConversationRoutineSteeringResolver;
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
  /**
   * Present when a routine parked at an external decision gate and the host must
   * create a pending decision row before the routine can be resumed.
   */
  awaitingDecision?: RoutineAwaitingDecision;
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
  resumeAwaitingDecision(input: ResumeAwaitingDecisionInput): Promise<ConversationRoutineDecisionResult>;
}
