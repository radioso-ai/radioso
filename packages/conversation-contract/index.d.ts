import type { ConversationModelGateway } from "./modelGateway.js";
import type { ReferenceTimeZone } from "./referenceTimeZone.js";
import type { RoutineRunTrace, RoutineSelectionTrace } from "./routineTrace.js";
import type { ConversationRoutineSlotCorrection } from "./routineSlotCorrection.js";
import type { RoutineConsentEvent, RoutineConsentSelectorInput } from "./routineConsent.js";
import type { ConversationRoutineReentryGate } from "./routineReentry.js";
import type {
  DecisionOption,
  Routine,
  RoutineHandoffTerminalKind,
  RoutineInputBinding,
  RoutineItemSelection,
  RoutineShownItems,
  RoutineStepReask,
  RoutineOperatorNoticeTemplate,
  RoutineSlotSchema,
  RoutineStep,
  RoutineTerminalKind,
  RoutineTransition,
} from "./routineGraph.js";
import type { PendingRenderableTurn, RenderableTurn } from "./renderableTurn.js";
import type { RoutineSkillOutcomeStatus, SkillOutcome, SkillOutcomeControl, SkillOutcomeError, SkillOutcomeStatus } from "./skillOutcome.js";

export type ConversationRole = "system" | "user" | "assistant" | "tool";

/** Provider-neutral semantic state for whether a request is resolved by admitted evidence. */
export type AnswerCoverage = "answered" | "partial" | "unanswered" | "unclear";
export type AnswerCoverageReason =
  | "sufficient_evidence"
  | "insufficient_evidence"
  | "conflicting_evidence"
  | "ambiguous_request"
  | "intentional_scope_boundary";
export type AnswerCoverageAvailability = "assessed" | "not_recorded" | "failed" | "invalid";
/**
 * Distinguishes which stage produced an assessment (#1260): the answer
 * envelope's own head, a turn's deterministic zero-evidence fallback, or the
 * pre-compose assessor (kept only as the shadow producer). Optional because
 * only the answer-head path (and its shadow) populates it; a host that never
 * produces a head-derived assessment carries no producer at all.
 */
export type AnswerCoverageProducer = "answer_head" | "deterministic" | "assessor";
export type AnswerCoverageAssessment =
  | {
      availability: "assessed";
      coverage: AnswerCoverage;
      reason: AnswerCoverageReason;
      unresolvedRequest?: string;
      schemaVersion: number;
      /** Persistence carries this on every written row now (#1260, FR-017); an assessed verdict always names its producer. */
      producer: AnswerCoverageProducer;
    }
  | { availability: Exclude<AnswerCoverageAvailability, "assessed">; producer?: AnswerCoverageProducer };

/** Bounded, admitted evidence passed to the semantic assessor. It is never telemetry. */
export interface AnswerCoverageEvidence {
  id: string;
  content: string;
  sourceLabel?: string;
}

/** A narrow, assessed-only signal available to authored interaction criteria. */
export interface AnswerCoverageSignal {
  coverage: AnswerCoverage;
  reason: AnswerCoverageReason;
}

/** Absent criteria preserve all legacy directive and routine behavior. */
export interface AnswerCoverageCriteria {
  coverage: AnswerCoverage[];
  reasons?: AnswerCoverageReason[];
}

/** A reply a turn wrote and did not publish. */
export interface ReplyDraft {
  readonly text: string;
  /**
   * What the published message row carries besides its text (skill outcome, grounding, citations
   * and the rest of its metadata). Host-owned and opaque to channels: it is stored with the draft
   * and written verbatim when the draft is published.
   */
  readonly presentation: Readonly<Record<string, unknown>>;
}

/*
 * The codes a review turn's facts carry. Each `declare const` has its runtime value in `index.js`;
 * the two change together. `unknown`, `not_assessed` and `unavailable` mean the host could not
 * tell, and are never read as publishable.
 */

/** How the turn answered. */
export declare const REPLY_OUTCOMES: readonly ["answered", "no_context", "out_of_scope", "unavailable"];
export type ReplyOutcome = typeof REPLY_OUTCOMES[number];

/** Whether the reply rests on the workspace's documents. */
export declare const REPLY_GROUNDINGS: readonly ["grounded", "ungrounded", "not_applicable", "unknown"];
export type ReplyGrounding = typeof REPLY_GROUNDINGS[number];

/** How completely the reply covers what the customer asked. */
export declare const REPLY_COVERAGES: readonly ["answered", "partial", "unanswered", "unclear", "unavailable", "not_assessed"];
export type ReplyCoverage = typeof REPLY_COVERAGES[number];

/**
 * What a review turn recorded about itself, mapped by the host from its own turn record: what a
 * channel's publication decision reads, and what a held reply keeps for a teammate to judge the
 * draft by. Read on these facts, never on the reply's text.
 */
export interface ReviewTurnFacts {
  outcome: ReplyOutcome;
  grounding: ReplyGrounding;
  coverage: ReplyCoverage;
  /** A hand-off the turn asked for. It is reported, never applied: ownership is unchanged. */
  handoff: { requested: false } | { requested: true; reason: string };
  /** Skills the turn would have run but did not, because a review turn acts on nothing. */
  suppressedEffects: readonly { skillName: string }[];
  citationCount: number;
}

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
  /** A card the visitor picked from a routine step's reply; the host validated it against the stored block. */
  itemSelection?: RoutineItemSelection;
  /** The items a routine step showed on its latest presentation, which a typed answer may name. */
  shownItems?: RoutineShownItems;
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
    }
  | {
      /**
       * Stable identity only: which mailbox, which thread, which participant. The thread's reply
       * token is a routing secret and never rides here; per-message facts (subject, CC, display
       * name) live on the email channel's own records.
       */
      provider: "email";
      mailbox: { id: string; address: string };
      threadKey: string;
      participant: { address: string };
    }
  | {
      /**
       * A spoken session. `vendor` names the namespace `sessionKey` belongs to (the voice runtime
       * that issued it); the key itself is opaque. `callerId` is E.164 and present only on `phone`.
       */
      provider: "voice";
      vendor: string;
      sessionKey: string;
      transport: "phone" | "web";
      callerId?: string;
    };

/**
 * Edge-observed facts about the request that opened a conversation (spec 1277,
 * FR-010). Every field is nullable: a request-facts value is either fully
 * proven by a signed edge envelope, partially derived from the backend's own
 * socket/headers, or entirely absent when a proxy marker carried no valid
 * proof. `userAgent` is capped at 512 chars and `acceptLanguage` at 256 by the
 * derivation site; the type itself does not enforce the cap.
 */
export interface ConversationRequestContext {
  clientIp: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
  /**
   * `"edge_proof"`: a first-party edge (the frontend proxy) signed the facts.
   * `"backend"`: no edge marker was present; the backend derived facts from its
   * own socket/headers directly. `"unproven"`: an edge marker was present but
   * failed to verify, so every fact is `null` rather than the proxy's own
   * address.
   */
  observedVia: "edge_proof" | "backend" | "unproven";
}

export type SteeringSource = "directive" | "skill" | "routine";

export type SteeringLifespan = "response" | "session";

/**
 * The generator a standing rule is addressed to. A turn produces visitor-facing text
 * from more than one model call, and a rule that governs one of them does not
 * necessarily govern another: "never suggest a question about price" belongs to the
 * follow-up question generator, not to the answer body.
 *
 * An empty or absent scope means `answer` — the historical behavior, where every rule
 * addressed the answer body and nothing else.
 */
export type GenerationSurface = "answer" | "suggested_questions";

export interface SteeringRule {
  /** Stable per-turn identity when the rule originates from an authored directive. */
  id?: string;
  /** Authored directive display name for operator-facing trace resolution. */
  directiveName?: string;
  action: string;
  condition?: string;
  priority?: number;
  description?: string;
  source: SteeringSource;
  lifespan: SteeringLifespan;
  /**
   * Generators this rule is addressed to. Empty/absent means `answer` only, so a rule
   * authored before surfaces existed keeps its exact meaning.
   */
  surfaces?: GenerationSurface[];
  /**
   * Present when this rule originates from a coverage-gated directive matched
   * before the coverage verdict exists (#1260). The rendering surface layers it
   * as a condition on the classification the model is about to emit; the
   * verdict's producer judges applicability once the verdict arrives.
   */
  coverageCriteria?: AnswerCoverageCriteria;
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
  /**
   * Optional authored generator scope. Empty means the answer body only. Orthogonal to
   * route scope: `routes` picks which turn path a directive applies on, `surfaces`
   * picks which generator inside that turn it addresses.
   */
  surfaces?: GenerationSurface[];
  priority?: number;
  /**
   * Optional cross-turn firing policy. Absent means `repeatable` (the historical
   * behavior): the directive may render on every turn its condition holds. The
   * host remembers which directives have fired per conversation and suppresses
   * `once_per_conversation` / `cooldown` re-fires before matching — matching
   * itself stays stateless. A directive counts as "fired" on a turn only when it
   * renders into the steering block, not when it merely matched.
   */
  lifecycle?: DirectiveLifecycle;
  requiredCapabilities?: string[];
  dependsOn?: string[];
  excludes?: string[];
  description?: string;
  metadata?: Record<string, unknown>;
  /** Optional typed semantic gate; absent retains the historical matching path. */
  coverageCriteria?: AnswerCoverageCriteria;
}

export type DirectiveLifecycle =
  | { kind: "repeatable" }
  | { kind: "once_per_conversation" }
  | { kind: "cooldown"; turns: number };

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
  /**
   * Whether this match may be turned back into prompt steering by an engine host.
   * A host-side resolution pass can retain a match for its trace and directive
   * binding while withholding it from every generation surface after applying a
   * steering bound. Absent means renderable for backwards compatibility.
   */
  renderInSteering?: boolean;
  /**
   * Surfaces this match still renders on after a host applied its steering bound,
   * when that is narrower than the directive's authored scope. Absent means the
   * directive's own scope. Kept beside the directive rather than written into it so a
   * bound stays a prompt-size decision: skill binding and the trace continue to read
   * the authored scope, and only prompt rendering narrows.
   */
  renderSurfaces?: GenerationSurface[];
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

export type {
  DirectiveCoherenceCheckInput,
  DirectiveCoherenceChecker,
  DirectiveCoherenceConflict,
  DirectiveCoherenceError,
  DirectiveCoherenceGate,
  DirectiveCoherenceGateOptions,
  DirectiveCoherenceInvocationContext,
  DirectiveCoherenceMode,
  DirectiveCoherenceVerdict,
} from "./directiveCoherence.js";

export interface DirectiveCatalogRegistryPort {
  list(): Directive[];
}

export type SkillInputScalarType = "string" | "number" | "integer" | "boolean" | "date";

interface SkillInputFieldBase {
  name: string;
  required: boolean;
  description?: string;
}

export type SkillInputField =
  | (SkillInputFieldBase & { type: "string"; permittedValues?: string[] })
  | (SkillInputFieldBase & { type: "number" | "integer" | "boolean" | "date"; permittedValues?: never });

export interface SkillInputSchema {
  fields: SkillInputField[];
}

export interface SkillDefinition {
  name: string;
  description?: string;
  inputSchema?: SkillInputSchema;
  outputSchema?: unknown;
  outcomeKinds?: string[];
  metadata?: Record<string, unknown>;
}

export type { RoutineSkillOutcomeStatus, SkillOutcome, SkillOutcomeControl, SkillOutcomeError, SkillOutcomeStatus } from "./skillOutcome.js";

/**
 * Narrow, per-turn channel handed to a skill executor so it can append
 * *structured* interim events to the live session while it works (e.g. an
 * order-lookup-in-progress status before the final result lands).
 *
 * It deliberately exposes no raw user-facing message channel. Assistant copy is
 * owned by the LLM / canned-rendering path in the turn loop, not authored in
 * skill code — Radioso is multilingual, and hard-coded conversational copy would
 * bypass localization and prompt-owned wording. Executors signal progress with
 * structured status/custom events; the loop decides whether and how to render
 * them to the user.
 *
 * Scoped to the current turn — it does not expose the session store. Wiring a
 * real emitter is owned by the chat turn loop; call sites without a live session
 * pass a no-op implementation.
 */
export interface SkillEmitPort {
  emitStatus(status: string, data?: Record<string, unknown>): Promise<void>;
  emitCustom(data: Record<string, unknown>): Promise<void>;
}

/**
 * Where a routine skill step's argument came from, so an executor can tell a value the
 * author wrote from one a visitor or host page supplied.
 * - `literal`: the author wrote it into the step's input binding.
 * - `slot`: a routine variable. Extraction can store a value under any routine variable
 *   name, so every routine variable, including one a skill output fills, counts as
 *   visitor-provided.
 * - `context`: a turn context variable, supplied by the host page or the visitor.
 */
export type SkillArgumentOrigin = "literal" | "slot" | "context";

/** Everything a skill executor needs for a single dispatch. */
export interface SkillInvocation {
  skill: SkillDefinition;
  collected: Record<string, unknown>;
  /**
   * Where each `collected` value came from, keyed like `collected`. A routine skill step
   * sets it; a dispatch whose inputs the model filled leaves it absent.
   */
  collectedOrigins?: Record<string, SkillArgumentOrigin>;
  context?: Record<string, unknown>;
  /** Interim-event channel for the current turn. */
  emit: SkillEmitPort;
  /** Cancels in-flight work when the turn is abandoned (new input, shutdown). */
  signal?: AbortSignal;
}

/**
 * A reference to a result that will arrive later as a session event. No v1
 * executor returns this; it exists so the async weave — dispatch a skill, keep
 * talking, reconcile the result in a later turn — is expressible without a
 * breaking change to this port. The engine that resolves a ticket is out of scope.
 */
export interface SkillDeferralTicket {
  ticketId: string;
}

/**
 * The result of dispatching a skill: either the outcome is available now
 * (`settled`) or it will arrive later as a session event (`deferred`). Modeling
 * dispatch as inbox/event-shaped rather than pure call-return is what keeps
 * deferred results from being foreclosed by the port's type.
 */
export type SkillDispatchResult =
  | { disposition: "settled"; outcome: SkillOutcome }
  | { disposition: "deferred"; ticket: SkillDeferralTicket };

export interface SkillExecutorPort {
  dispatch(invocation: SkillInvocation): Promise<SkillDispatchResult>;
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

export type { ReferenceTimeZone, ReferenceTimeZoneSource } from "./referenceTimeZone.js";

export interface TurnContext {
  agent: ConversationAgentConfig;
  sessionId: string;
  inputEvent: ConversationInputEvent;
  history: ConversationMessage[];
  stagedContext: StagedContext[];
  steering: SteeringRule[];
  activeRoutineId?: string;
  activeStepId?: string;
  /** The {@link RoutineState.executionId} of the run the turn's routine step belongs to. */
  activeRoutineExecutionId?: string;
  /** The zone every "today" on this turn reads; a consumer reads UTC when it is absent. */
  referenceTimeZone?: ReferenceTimeZone;
  metadata?: Record<string, unknown>;
}

export interface SelectedSkill {
  skillName: string;
  input?: unknown;
  reason?: string;
  metadata?: Record<string, unknown>;
  /** Registered skill the engine dispatches in place of this one when it settles `failed`; an in-progress status never falls back. */
  fallbackSkillName?: string;
  /** Set by the engine on a fallback selection: the skill it stands in for and how that skill settled. */
  fallbackFor?: { skillName: string; outcomeStatus: SkillOutcomeStatus; failureReason?: string };
}

export type SkillInputValue = string | number | boolean;
export type SkillInputFieldProvenance = "host" | "model" | "none";
export type SkillInputFieldStatus = "ready" | "absent" | "rejected";

export interface SkillInputFieldOutcome {
  name: string;
  provenance: SkillInputFieldProvenance;
  status: SkillInputFieldStatus;
  reason?: string;
}

export interface OutstandingSkillInputField {
  name: string;
  type: SkillInputScalarType;
  description?: string;
  permittedValues?: string[];
  reason: "absent" | "rejected";
}

export type ConversationSkillInputResolution =
  | { kind: "ready"; input: Record<string, SkillInputValue>; fields: SkillInputFieldOutcome[] }
  | { kind: "needs_input"; fields: SkillInputFieldOutcome[]; outstanding: OutstandingSkillInputField[] }
  | { kind: "failed"; code: string; fields: SkillInputFieldOutcome[] };

export interface ConversationSkillInputResolver {
  resolve(input: {
    skill: SkillDefinition;
    selected: SelectedSkill;
    turn: TurnContext;
  }): Promise<ConversationSkillInputResolution>;
}

export interface AwaitingSkillInput {
  skillName: string;
  fields: OutstandingSkillInputField[];
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

export type { DirectiveAdherenceEntry, ItemListBlock, ReplyAction, ReplyBlock, ReplyBlockLayout, ReplyButtonLabels, ReplyFact, ReplyImage, ReplyItem, PendingRenderableTurn, RenderableTurn } from "./renderableTurn.js";

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

export type {
  ConversationModelCompletion,
  ConversationModelGateway,
  ConversationModelRequest,
  ConversationModelStopReason,
} from "./modelGateway.js";

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
  /**
   * Where a retrieval-style skill reports its coverage verdict, from inside
   * compose, before releasing any answer text (#1260). The engine constructs
   * this at compose time and owns everything it does with the verdict —
   * directive applicability, routine activation, reaction recording; the
   * composer only has to forward it to the skill it renders. Absent leaves a
   * skill that receives no sink proceeding exactly as it does today.
   */
  coverageVerdict?: ConversationCoverageVerdictSink;
}

/**
 * The one call a retrieval-style skill makes to hand its coverage verdict to the
 * engine before releasing any answer text (#1260, FR-005). The skill knows
 * nothing about what the engine does with the verdict — routines, directives,
 * persistence — only whether to proceed or yield the turn. Called at most once
 * per turn; a second call is answered with `proceed` rather than an error.
 */
export interface ConversationCoverageVerdictSink {
  report(input: { assessment: AnswerCoverageAssessment }): Promise<{ decision: "proceed" | "yield_turn" }>;
}

export interface ConversationTurnComposer {
  compose(input: ConversationTurnComposeInput): Promise<RenderableTurn>;
}

export interface ConversationTurnStreamComposer extends ConversationTurnComposer {
  stream(input: ConversationTurnComposeInput): AsyncIterable<TurnStreamEvent>;
  streamCommitted?(response: RenderableTurn): Iterable<string>;
}

/**
 * A session's position in an in-flight Routine (a stateful, multi-step flow).
 * `path` is the node-index history (last element is the current step); `variables`
 * holds captured slots. The engine persists this between turns and resumes from it.
 */
export interface RoutineState {
  sessionId: string;
  routineId: string;
  /** Stable identifier for this concrete routine run, when the host persists one. */
  executionId?: string;
  /** The visitor message that activated this run; host-owned transcript boundary. */
  startedMessageId?: string;
  path: string[];
  variables: Record<string, unknown>;
  /** Per-step entry counts, used by deterministic counter guards. */
  attempts?: Record<string, number>;
  /**
   * Consecutive times the current step was asked again without the visitor filling any of the
   * step's empty slots (#1376); replacing a value the step already held does not count. Back to
   * 0 (or absent) when the routine enters a step or a turn fills one of the step's empty slots;
   * a turn yielded to normal answering leaves it unchanged. Past the limit the step asks
   * differently, and a routine with a hand-off end that is still stuck one turn later ends
   * `stuck` (#1384).
   */
  reaskCount?: number;
  status: "active" | "suspended" | "completed" | "expired";
  metadata?: Record<string, unknown>;
}

export type * from "./routineGraph.js";

/**
 * A slot value as a reader that expects a scalar reads it: an `item` value reads as its title,
 * any other value as it is. The one reading rule every copy of a routine's values shares.
 */
export declare function readableSlotValue(value: unknown): unknown;

/** The bounds of a {@link RoutineItemValue}, the stored card's own: its host copies within them and the engine checks them. */
export declare const ROUTINE_ITEM_VALUE_LIMITS: Readonly<{ key: 128; title: 160; link: 2048; fields: 12; fieldKey: 64; fieldValue: 200 }>;

export interface RoutineAwaitingDecision {
  stepId: string;
  options: DecisionOption[];
  captureKey: string;
  reason?: string;
}

/** A fire-and-forget side effect a routine requested: an authored `type` + payload. */
export interface RoutineActionRequest {
  type: string;
  payload: Record<string, unknown>;
  /**
   * The host skill that delivers this request, kept off the payload because it is routing,
   * not content. The engine never sets it; a host that turns an effect into an action does.
   */
  skillName?: string;
}

/**
 * Whether a value may leave the conversation as it was given. It is authored on whatever holds
 * the value (a routine slot, a context variable) and never inferred from a name or the value
 * itself. A `sensitive` value stays where the conversation runs, in a routine's own state and in
 * the transcript, and reads as {@link REDACTED_VALUE} in every copy that leaves: a notice, an
 * action payload, a skill's arguments, a trace.
 */
export type ValueSensitivity = "normal" | "sensitive";

/** What a sensitive value reads as wherever a copy of it leaves the conversation. */
export declare const REDACTED_VALUE: "[redacted]";

/**
 * The record with the value of every key in `sensitiveKeys` replaced by {@link REDACTED_VALUE}.
 * A key the record does not hold stays absent, so a masked copy never claims a value was
 * collected when it was not. The one masking rule routine slots and context variables share.
 */
export declare function redactSensitiveValues<TValue>(
  values: Readonly<Record<string, TValue>>,
  sensitiveKeys: Iterable<string>,
): Record<string, TValue | typeof REDACTED_VALUE>;

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
  /**
   * When true on a chat step's decision, that step takes no exit this turn — AI-decides,
   * rule, or default — nothing is fast-forwarded past it, and it is asked again.
   * `variables` are still merged into routine state, so they count from the next turn. The
   * selector sets it when the message carries text posing as a system, operator, or
   * assistant message; it can only do so on a turn where it is consulted, which a chat step
   * whose exits are all rules and that has nothing to extract never does. The runner applies
   * the same hold when a value for one of the step's own slots does not fit its declared
   * type. On a tool step's follow-up exits a decline still takes the default exit, because
   * holding the tool step could run its tool again.
   */
  hold?: boolean;
  /**
   * Set when the selector could not read its decision, so it judged no exit this turn (#1715):
   * `read` when a slot-only reading still read the message, `unread` when nothing did. A step
   * with an exit a model must judge then takes no exit, its rule and default exits included.
   */
  exitsUnjudged?: "read" | "unread";
  rationale?: string;
  /** What the model returned, for the debug trace. Absent when no model call ran. */
  selection?: RoutineSelectionTrace;
}

/** The result of dispatching a Routine skill (tool) step. */
export interface RoutineSkillResult {
  status: RoutineSkillOutcomeStatus;
  outputs?: Record<string, unknown>;
  answer?: string;
  /** Host-private dispatch metadata. Not rendered into routine prompts. */
  metadata?: Record<string, unknown>;
  /**
   * Whether running the skill may have acted outside the conversation — sent an email,
   * called a webhook, posted a message — before the host saves the turn. `false` only when
   * the host knows the skill stayed inside it (it read workspace evidence, or never ran).
   * Absent counts as `true`.
   */
  actsOutsideConversation?: boolean;
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
    /** Authored step identity; supplied by the runner for host-owned effect journals. */
    stepId?: string;
    /** One-based visit count for this step in the current runner traversal. */
    occurrenceOrdinal?: number;
    /** Stable identity for this skill step when its enclosing operation is retried. */
    idempotencyKey?: string;
    /**
     * The routine's slot keys marked sensitive. A step with no input bindings passes the
     * routine's variables wholesale, and these read as {@link REDACTED_VALUE} there; a step whose
     * binding names a sensitive slot passes its value, because its author named it.
     */
    sensitiveSlotKeys?: readonly string[];
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
    /** False when the message is a structured call that states no slot values: only the exit is kept. */
    messageStatesSlotValues?: boolean;
  } & RoutineConsentSelectorInput): Promise<RoutineNextStepDecision>;
}

/**
 * Renders the reply for the routine's current step. The host implements this with
 * the Radioso composer (the projected step steering is passed in), so the pure
 * engine owns graph mechanics and the host owns generation/presentation. It is told
 * only what it needs to write the message — the step and its projected steering for
 * this turn, and on a re-ask what the step still lacks — not the graph topology or
 * slot values.
 *
 * The rules play two roles (#1351): a `source: "routine"` rule is the step's own
 * instruction and controls what the message asks for or does; every other rule
 * (authored directives) is subordinate guidance that shapes how it is said and
 * never replaces the step's question or action.
 */
export interface ConversationRoutineStepRenderer {
  render(input: RoutineStepReplyInput): Promise<RenderableTurn>;
  /**
   * Decides the reply without generating it: no model call happens until the returned
   * reply's `render()` or `stream()`, and `prepare(input).render()` produces what
   * `render(input)` would. Optional; a runner without it renders with `render`.
   */
  prepare?(input: RoutineStepReplyInput): PendingRenderableTurn;
}

/** What a routine step's reply is written from. */
export interface RoutineStepReplyInput {
  step: RoutineStep;
  steering: SteeringRule[];
  turn: TurnContext;
  reask?: RoutineStepReask;
  /**
   * True when the runner ends the routine on `step` because the visitor stayed stuck on it
   * past the re-ask limit, and a person takes the conversation over (#1384). The reply tells
   * the visitor a person continues from here; it neither asks the step's question nor
   * follows its instruction, so `steering` is empty and `reask` absent.
   */
  stuckHandoff?: boolean;
  /** {@link RoutineContextRenderer.evidence} of the context variables the step references; absent when none carries any. */
  contextEvidence?: readonly string[];
}

/**
 * Which directives steered one routine step's reply, recorded as
 * `outputs.routineStep` on the routine turn's `directive_steering` stage (#1351) so
 * an operator can see every rule that touched the step. Ids and names only — never
 * the directive text.
 */
export interface RoutineStepSteeringTrace {
  routineId: string;
  stepId: string;
  /** The step instruction controlled the reply; these directives only shaped it. */
  directivesAppliedAs: "subordinate_to_step_instruction";
  /** Directives addressed to the step reply after matching and verdict gating. */
  steeringDirectives: Array<{ id?: string; name?: string }>;
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

export type * from "./routineConsent.js";

export type {
  ConversationRoutineSlotCorrection,
  RoutineSlotCorrectionCandidate,
  RoutineSlotCorrectionDetection,
  RoutineSlotCorrectionSkipReason,
} from "./routineSlotCorrection.js";

export type { ConversationRoutineReentryGate, RoutineReentryDecision } from "./routineReentry.js";

export interface RoutineDecisionInput {
  handle: string;
  optionId: string;
  payload?: unknown;
  /**
   * Stable, non-secret identity for effects caused by this decision. A retry after the host
   * rolls its transaction back carries the same value, so an effect-owning skill can dedupe.
   */
  idempotencyKey?: string;
}

export type {
  RoutineRunTrace,
  RoutineSelectionTrace,
  RoutineTraceRejectedSlot,
  RoutineTraceSlotValue,
  RoutineTraceStepEntry,
  RoutineUnreadableReason,
} from "./routineTrace.js";

/**
 * What a routine turn asks its host to record with the turn, beside its reply and routine state:
 * records that exist only because a routine step ran. The runner reports them, and the engine
 * carries the object whole, unread, from the runner's result to the claim's effects, the settled
 * {@link ProcessTurnResult}, and a decision resume's result, so a new kind of record is one more
 * field here. Absent when the turn has none.
 *
 * The turn's outbox `actions`, its ending (`terminal`, and the `handoff` and `operatorNotice` the
 * engine derives from it) and `skillsWithExternalEffects` stay beside it: the host merges its own
 * actions into the outbox, the engine reads the ending, and the host records nothing for the last.
 */
export interface RoutineHostEffects {
  /**
   * The routine parked at an external decision gate. Mutually exclusive with terminal exits and
   * yielded turns; when present, `nextState.status === "suspended"`, and the host creates a
   * pending decision before the routine can be resumed.
   */
  awaitingDecision?: RoutineAwaitingDecision;
  /** What the turn did with the routine's consents, in order; see {@link RoutineConsentEvent}. */
  consentEvents?: RoutineConsentEvent[];
}

export interface ConversationRoutineResumeResult {
  response: RenderableTurn;
  /**
   * The next state to persist; `null` when the routine ended this turn (`terminal` says how). A
   * host keeps the ended run as completed rather than active, with the values in `endedVariables`.
   */
  nextState: RoutineState | null;
  /**
   * How the routine ended, when it did: at an authored terminal step of that kind, or `stuck`
   * on the chat step `stepId` (see {@link RoutineTerminalKind}). `collected` is the routine's
   * declared slot values keyed by slot key — the same projection a completion export sends —
   * so a handoff can carry what the routine gathered; a sensitive slot's value reads as
   * {@link REDACTED_VALUE} there, and only `endedVariables` keeps it. `operatorNotice` is the template the
   * landed terminal step carries, present exactly when an authored ending notifies operators —
   * a `stuck` ending never carries one, since it lands on no authored terminal step.
   */
  terminal?: {
    kind: RoutineTerminalKind;
    stepId: string;
    collected?: Record<string, unknown>;
    /** The keys of `collected` whose values were masked as sensitive; absent when none were. */
    sensitiveSlotKeys?: string[];
    operatorNotice?: RoutineOperatorNoticeTemplate;
  };
  /**
   * Reported with `terminal`: every value the run holds as it ends, the slots its ending
   * turn captured and the tool outputs it assigned included. `nextState` is `null` then, so
   * this is what a host keeps on the ended run's record (#1452). `terminal.collected` is its
   * declared-slot projection.
   */
  endedVariables?: Record<string, unknown>;
  outcomes?: TurnOutcome[];
  /** Fire-and-forget side effects the routine emitted this turn, for the host to persist. */
  actions?: RoutineActionRequest[];
  /** What the host records with this turn because a routine step ran; see {@link RoutineHostEffects}. */
  hostEffects?: RoutineHostEffects;
  /**
   * The skills this turn's skill steps ran, in order, that may have acted outside the
   * conversation the moment they ran (an email sent, a webhook called) — every dispatched
   * skill whose result did not report `actsOutsideConversation: false`. Absent when there
   * were none. The host can no longer take such an effect back if saving the turn fails.
   */
  skillsWithExternalEffects?: string[];
  /** Step-by-step traversal record for the debug panel (omitted on a yield). */
  trace?: RoutineRunTrace;
  /**
   * When true, the routine *declined* this turn: the user's message was off-topic for
   * the routine, so the engine yields to normal answering and leaves the routine's
   * position unchanged (to resume later). `response`/`nextState` are ignored — the
   * runner returns inert placeholders.
   */
  yielded?: boolean;
  /** On a yielded result, the step the routine stays parked on. */
  pendingStep?: RoutinePendingStep;
}

/**
 * The step a routine waits on after it yields a turn. The turn is answered normally,
 * and the answer can close by pointing the visitor back to this step. It carries what
 * the step asks for and never a captured value, so a host may place it in a system prompt.
 */
export interface RoutinePendingStep {
  stepId: string;
  /**
   * The step's authored instruction with each slot reference shown as its bracketed key
   * (`[email]`) and each context reference empty.
   */
  instruction: string;
  /** Keys of the step's required collected slots that are still unfilled. Keys only, never values. */
  missingSlotKeys: string[];
}

/**
 * The active routine declined this turn and stays parked to resume on a later one.
 * `sessionId` and `inputEventId` name the turn it declined: `processTurn` honors a yield
 * handed back only on that same turn. `pendingStep` is absent when the runner reported none.
 */
export interface RoutineTurnYield {
  sessionId: string;
  /** Absent when the turn's input event carries no id; such a yield is never honored on hand-back. */
  inputEventId?: string;
  routineId: string;
  executionId?: string;
  pendingStep?: RoutinePendingStep;
}

/** Told when `attemptRoutine` returns null because the active routine yielded the turn. */
export interface ConversationRoutineYieldSink {
  yielded(routineYield: RoutineTurnYield): void;
}

export interface ConversationRoutineDecisionResult extends ConversationRoutineResumeResult {
  resumed: boolean;
  /**
   * The routine-ending effects `terminal` implies, as a live turn reports them on
   * `ProcessTurnResult`: a resumed routine that lands on an ending hands off and notifies the
   * same way.
   */
  handoff?: ProcessTurnResult["handoff"];
  operatorNotice?: RoutineOperatorNoticeEffect;
  /**
   * Present when the resume ended the routine (`terminal` is set, `nextState` is `null`): the
   * completed record to keep in its place, the same record a live turn that ends a routine keeps
   * (#1457). A yielded resume reports no next state and no completed record.
   */
  completedState?: RoutineState;
}

/**
 * Advances an active Routine one step for the current turn. The runner is the seam
 * the declarative model + LLM progression fill; the engine only claims or resumes
 * through it and persists the returned next state.
 */
export interface ConversationRoutineRunner {
  resume(input: ConversationRoutineResumeInput): Promise<ConversationRoutineResumeResult>;
  /**
   * `resume` split at the reply: walks the routine and decides the turn, but generates no
   * reply text. Resuming equals claiming and then rendering the claimed reply. Optional; the
   * engine resumes a runner without it.
   */
  claim?(input: ConversationRoutineResumeInput): Promise<ConversationRoutineClaim>;
}

export interface ConversationRoutineResumeInput {
  turn: TurnContext;
  state: RoutineState;
  steeringResolver?: ConversationRoutineSteeringResolver;
  /**
   * True when this routine's `state` was created by this very turn (a fresh
   * activation or a completed-routine reentry — both start from `path: []`), i.e.
   * the user's message is the trigger that started/reopened the routine, not a reply
   * to a step the routine has already rendered. On such a turn a next-step selector
   * that reads the message as an off-topic reply must not be allowed to yield and
   * silently drop the activation; the runner lands on (renders) the current step
   * instead. Absent/false on a normal resume, where the message is a reply.
   */
  activationTurn?: boolean;
  /**
   * True when the turn applies an operator's decision to a routine parked at an approval
   * gate. The decision, not the visitor's last message, is what the turn answers, so a
   * next-step selector that reads that message as off-topic cannot yield the turn: the
   * routine stays where the selector left it, and a gate with no exit taken parks again for
   * a new decision (#1460).
   */
  decisionTurn?: boolean;
  /**
   * Stable identity shared by every retry of one enclosing operation. The runner adds the
   * skill-step id before dispatch, so distinct skill steps never collapse into one effect.
   */
  skillDispatchIdempotencyScope?: string;
}

/** Everything a resumed routine turn decided except its reply. */
export type ConversationRoutineRunEffects = Omit<ConversationRoutineResumeResult, "response" | "yielded" | "pendingStep">;

/**
 * A routine turn walked but not yet replied to. `yielded`: the routine declined the turn
 * (see {@link ConversationRoutineResumeResult.yielded}) and nothing is rendered. `claimed`:
 * `effects` is what the turn decided — next state, ending, actions, decision gate, trace —
 * and `reply` generates the reply that goes with it.
 */
export type ConversationRoutineClaim =
  | { kind: "yielded"; pendingStep?: RoutinePendingStep }
  | { kind: "claimed"; effects: ConversationRoutineRunEffects; reply: PendingRenderableTurn };

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

/** Post-evidence routine activator with bounded, non-content diagnostics. */
export interface ConversationCoverageRoutineActivator extends ConversationRoutineActivator {
  evaluateCandidates(input: {
    turn: TurnContext;
    suppressedRoutineIds?: readonly string[];
  }): readonly {
    routineId: string;
    decision: "candidate" | "suppressed";
    reasonCode: string;
  }[];
  /**
   * Applies semantic reentry only after the current turn has a fresh matching
   * coverage assessment. The normal pre-evidence reentry port must not see
   * these routines.
   */
  reentryGate?: ConversationRoutineReentryGate;
}

export interface ProcessTurnInput {
  agent: ConversationAgentConfig;
  sessionId: string;
  inputEvent: ConversationInputEvent;
  /** Carried onto every turn context the engine builds for this turn. */
  referenceTimeZone?: ReferenceTimeZone;
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
  /** Required when a selected skill declares input fields. */
  skillInputResolver?: ConversationSkillInputResolver;
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
  /** A second activation pass for coverage-gated routines, after the normal activator, so an active routine keeps control. */
  coverageRoutineActivator?: ConversationCoverageRoutineActivator;
  /** Records bounded post-evidence decisions without exposing request/evidence text. */
  coverageReactionRecorder?: ConversationCoverageReactionRecorder;
  /**
   * The active routine already yielded this turn: the host ran `attemptRoutine` before
   * preparing the turn. When its session and input event match this input, the engine
   * records the yield on the turn's trace and does not ask the routine about the same
   * message again; otherwise it ignores it and attempts the routine as usual.
   */
  routineYield?: RoutineTurnYield;
}

export interface ConversationCoverageReactionRecorder {
  record(input: {
    assessment: Extract<AnswerCoverageAssessment, { availability: "assessed" }>;
    evaluationState: "evaluated" | "suppressed";
    reactions: readonly {
      reactionKey: string;
      directiveId?: string;
      routineId?: string;
      routineExecutionId?: string;
      decision: "matched" | "applied" | "offered" | "activated" | "skipped" | "suppressed";
      reasonCode: string;
    }[];
  }): Promise<void>;
}

export type ConversationProgressPhase =
  | "preparing"
  | "interpreting"
  | "retrieving"
  | "selecting"
  | "dispatching"
  | "composing"
  | "routine";

export interface ConversationProgressPort {
  report(input: { phase: ConversationProgressPhase }): void;
}

export interface ProcessTurnStreamInput extends Omit<ProcessTurnInput, "composer"> {
  composer: ConversationTurnStreamComposer;
  progress?: ConversationProgressPort;
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
  /** Carried onto the routine's turn context when the host supplies none. */
  referenceTimeZone?: ReferenceTimeZone;
  stores: ConversationStores;
  /**
   * Optional host-prepared turn context. Post-evidence activation supplies this so
   * a coverage-gated routine sees the same admitted evidence and assessment signal
   * that selected it. Legacy activation continues to construct its historical
   * empty-context turn when this is absent.
   */
  turnContext?: TurnContext;
  /** The host already durably appended this input event; routine output still references it. */
  inputEventAlreadyAppended?: boolean;
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
  progress?: ConversationProgressPort;
  /** Told when the active routine yields the turn, so the host can carry its pending step into the answer. */
  routineYieldSink?: ConversationRoutineYieldSink;
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
  /** Present only when this turn started or resumed a concrete routine execution. */
  routineExecution?: {
    routineId: string;
    executionId?: string;
  };
  /** Routine IDs actually presented in an activation clarification on this turn. */
  routineClarificationRoutineIds?: string[];
  trace: ConversationTrace;
  /**
   * Fire-and-forget action requests a routine emitted this turn. The host persists
   * these to its outbox (transactionally with the turn) and a worker dispatches them;
   * the engine only declares them.
   */
  actions?: RoutineActionRequest[];
  /** What the host records with this turn because the routine that ran asked it to; see {@link RoutineHostEffects}. */
  hostEffects?: RoutineHostEffects;
  /**
   * The skills a routine's skill steps ran this turn that may have acted outside the
   * conversation; see {@link ConversationRoutineResumeResult.skillsWithExternalEffects}.
   */
  skillsWithExternalEffects?: string[];
  /** Required fields that prevented selected skills from dispatching this turn. */
  awaitingSkillInput?: AwaitingSkillInput[];
  /**
   * Present when a routine ended by handing the conversation to a person: at an authored
   * hand-off terminal (`terminalKind: "handoff"`), stuck past its re-ask limit (`"stuck"`, on the
   * step it was stuck on), or on a declined consent (`"consent_declined"`, on its step). Ownership only —
   * whether operators are told is `operatorNotice`. `collected` carries the routine's declared
   * slot values keyed by slot key, for the host's operator notice.
   */
  handoff?: {
    routineId: string;
    stepId: string;
    terminalKind: RoutineHandoffTerminalKind;
    collected?: Record<string, unknown>;
    /** The keys of `collected` whose values were masked as sensitive; absent when none were. */
    sensitiveSlotKeys?: string[];
  };
  /**
   * Present when a routine ended on a terminal that notifies operators: every hand-off, and a
   * completion that carries an operator notice. `collected` is the routine's declared slot
   * values keyed by slot key; `subject`/`intro` are the authored templates, absent when the
   * host's default applies. A side effect only — it never changes who owns the conversation.
   */
  operatorNotice?: RoutineOperatorNoticeEffect;
}

/**
 * What a routine ending tells operators, as the engine reports it; see
 * {@link ProcessTurnResult.operatorNotice}. The notice an author stores on a terminal is
 * `RoutineOperatorNotice` in `@radioso/routine-definition`. `stuck` and `consent_declined` only
 * ever come from a host's own default notice for a runner-owned hand-off (#1384, #1544) — the
 * engine itself never reports one, since such an ending lands on no authored terminal step to
 * carry one.
 */
export interface RoutineOperatorNoticeEffect extends RoutineOperatorNoticeTemplate {
  routineId: string;
  stepId: string;
  terminalKind: "complete" | RoutineHandoffTerminalKind;
  collected?: Record<string, unknown>;
  /**
   * The keys of `collected` whose values were masked as sensitive; absent when none were. A
   * notice decides what reads as sensitive from these, never from a value's text.
   */
  sensitiveSlotKeys?: string[];
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
   * A yield is also reported to `input.routineYieldSink`; the host passes it on to
   * `processTurn` as `routineYield`.
   */
  attemptRoutine(input: AttemptRoutineInput): Promise<ProcessTurnResult | null>;
  /**
   * `attemptRoutine` split at the reply: claims the turn exactly when `attemptRoutine`
   * would, and returns null otherwise, but generates no reply text. The holder generates
   * the reply and settles the claim with it; `attemptRoutine` is that sequence with
   * `reply.render()`. Optional, so an engine a host supplies without it still conforms.
   */
  claimRoutine?(input: AttemptRoutineInput): Promise<ConversationRoutineTurnClaim | null>;
  resumeAwaitingDecision(input: ResumeAwaitingDecisionInput): Promise<ConversationRoutineDecisionResult>;
}

/**
 * A turn the routine machinery claimed, before its reply exists. Generate the reply once,
 * with `reply.render()` or `reply.stream()`, then pass the finished reply to `settle`, which
 * records the turn — routine state, response event, trace — and returns its result.
 */
export interface ConversationRoutineTurnClaim {
  effects: RoutineTurnEffects;
  reply: PendingRenderableTurn;
  settle(response: RenderableTurn): Promise<ProcessTurnResult>;
}

/**
 * What a claimed routine turn does besides replying, known before the reply is generated:
 * the same values the settled {@link ProcessTurnResult} reports. Empty for a turn that runs
 * no routine step (an activation clarification, a completed-routine slot correction).
 */
export interface RoutineTurnEffects {
  routineExecution?: ProcessTurnResult["routineExecution"];
  /** How the routine ended this turn, when it did. */
  terminalKind?: RoutineTerminalKind;
  actions?: RoutineActionRequest[];
  hostEffects?: RoutineHostEffects;
  handoff?: ProcessTurnResult["handoff"];
  operatorNotice?: RoutineOperatorNoticeEffect;
  /** The skills the routine already ran while claiming the turn that may have acted outside the conversation. */
  skillsWithExternalEffects?: ProcessTurnResult["skillsWithExternalEffects"];
}

/**
 * Ranked routine activation. These describe the surface a host planner shares with a
 * routine registry — trigger metadata in, ranked verdicts out. They live here rather
 * than beside the default registry because a host that ranks candidates itself must be
 * able to conform to them without depending on the default implementation.
 */
export interface RoutineActivationTrigger {
  routineId: string;
  description: string;
}

export interface RoutineActivationPrefilterScore {
  routineId: string;
  score: number;
}

export interface RoutineActivationPrefilter {
  minScore?: number;
  topK?: number;
  rank(input: {
    query: string;
    triggers: readonly RoutineActivationTrigger[];
    turn: TurnContext;
  }): Promise<readonly RoutineActivationPrefilterScore[]>;
}

/**
 * A registered Routine plus declarative trigger metadata for ranked activation.
 * Reentry policy is deliberately absent here: it is read off `routine.activation`, so
 * a registration cannot contradict the routine it registers.
 */
export interface RoutineRegistration {
  routine: Routine;
  trigger: {
    description: string;
    priority: number;
    gateRef?: string;
    eligible?: (input: { turn: TurnContext }) => boolean;
    explicitClaim?: (input: { turn: TurnContext }) => { variables?: Record<string, unknown> } | null;
  };
}

/** One ranked routine verdict, as the ranked-activation model step produces it. */
export interface RankedRoutineMatch {
  routineId: string;
  confidence: number;
  variables?: Record<string, unknown>;
}

/**
 * Planner-consumable summary of one prepared candidate: enough to build a ranking
 * prompt (title, trigger, priority) without exposing any activation policy.
 */
export interface RoutineCandidateSummary {
  routineId: string;
  title: string;
  triggerSummary: string;
  priority: number;
}

/** The activator's non-null outcome (activate or clarify). */
export type RoutineActivationResult = NonNullable<
  Awaited<ReturnType<ConversationRoutineActivator["activate"]>>
>;

/**
 * The rankable subset of a candidate preparation: the eligible, prefilter-bounded
 * registrations plus their planner summaries, so a ranked decision can be applied from
 * either a ranked-activation call or a planner's precomputed scores.
 */
export interface RankableRoutineCandidates {
  kind: "rank";
  registrations: readonly RoutineRegistration[];
  candidates: readonly RoutineCandidateSummary[];
}

/**
 * Outcome of the pre-rank eligibility pipeline. `claim` and `none` are resolved
 * without any ranking call; only `rank` proceeds to the ranked-activation step.
 */
export type PreparedRoutineCandidates =
  | RankableRoutineCandidates
  | { kind: "claim"; activation: RoutineActivationResult }
  | { kind: "none" };

/**
 * Renders one staged context variable for a routine step; the host owns what any variable looks
 * like, and the engine knows no field of any of them. `render` is the text substituted for each
 * `{{context.<name>}}` token in a step's action; `evidence` is untrusted content the step reply
 * reads as quoted data beside the instruction, never in it. Each is null when there is none.
 */
export interface RoutineContextRenderer {
  render(input: { name: string; stagedContext: readonly StagedContext[] }): string | null;
  evidence?(input: { name: string; stagedContext: readonly StagedContext[] }): string | null;
}

/** Renders a grounded answer for a routine step, or null when the step is not groundable. */
export interface RoutineGroundedAnswerRenderer {
  render(input: RoutineGroundedAnswerInput): Promise<RenderableTurn | null>;
  /**
   * Decides from the turn's staged context alone whether the step is groundable: null when
   * it is not, otherwise the grounded answer, generated only when asked.
   * `prepare(input)?.render()` produces what `render(input)` would. Optional.
   */
  prepare?(input: RoutineGroundedAnswerInput): PendingRenderableTurn | null;
}

export type RoutineGroundedAnswerInput = Pick<RoutineStepReplyInput, "step" | "steering" | "turn">;

/**
 * Tool-backed skills. A host that exposes tools (MCP, OpenAPI, local functions) implements
 * `ToolService`; the bridge that turns one into a skill executor implements
 * `ToolSkillExecutorPort`. Both are contracts, so a host can supply either without
 * depending on the bundled tool adapters.
 */
export interface ConversationToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  outcomeKinds?: string[];
  metadata?: Record<string, unknown>;
}

export interface ToolCallContext {
  turn?: TurnContext;
  skill?: SkillDefinition;
  selected?: SelectedSkill;
  signal?: AbortSignal;
  /** Stable identity an effect-owning tool can use to dedupe a retried call. */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallInput {
  toolName: string;
  input?: unknown;
  context?: ToolCallContext;
}

export interface ToolCallResult {
  status?: SkillOutcomeStatus;
  answer?: string;
  output?: unknown;
  outputs?: Record<string, unknown>;
  control?: SkillOutcomeControl;
  guidance?: SkillTransientGuidance[];
  metadata?: Record<string, unknown>;
  error?: SkillOutcomeError;
  stagedContext?: StagedContext[];
  steering?: SteeringRule[];
  subTrace?: CapabilitySubTrace;
}

export interface ToolService {
  listTools(): Promise<ConversationToolDefinition[]>;
  callTool(input: ToolCallInput): Promise<ToolCallResult | SkillOutcome | unknown>;
}

export interface ToolSkillMetadata {
  toolName: string;
  source?: string;
}

export interface ToolSkillDefinition extends SkillDefinition {
  metadata: Record<string, unknown> & {
    conversationTool: ToolSkillMetadata;
  };
  execution: {
    kind: "internal";
    adapter: string;
  };
}

export interface ToolSkillDefinitionOptions {
  skillNamePrefix?: string;
  source?: string;
  executionAdapter?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolSkillEmitPort {
  emitStatus(status: string, data?: Record<string, unknown>): Promise<void>;
  emitCustom(data: Record<string, unknown>): Promise<void>;
}

export interface ToolSkillInvocation {
  skill: SkillDefinition;
  collected: Record<string, unknown>;
  context?: Record<string, unknown>;
  emit: ToolSkillEmitPort;
  signal?: AbortSignal;
}

export type ToolSkillDispatchResult =
  | { disposition: "settled"; outcome: SkillOutcome }
  | { disposition: "deferred"; ticket: { ticketId: string } };

export interface ToolSkillExecutorPort {
  dispatch(invocation: ToolSkillInvocation): Promise<ToolSkillDispatchResult>;
}
