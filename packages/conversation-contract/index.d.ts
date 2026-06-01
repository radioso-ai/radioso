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

export type SteeringSource = "directive" | "skill";

export type SteeringLifespan = "response" | "session";

export type SteeringCriticality = "low" | "medium" | "high";

export interface SteeringRule {
  action: string;
  condition?: string;
  priority?: number;
  criticality?: SteeringCriticality;
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
  criticality?: SteeringCriticality;
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
}

export interface ConversationTraceLink {
  from: string;
  to: string;
  kind: string;
}

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
  selector: ConversationSkillSelector;
  composer: ConversationTurnComposer;
}

export interface ProcessTurnStreamInput extends Omit<ProcessTurnInput, "composer"> {
  composer: ConversationTurnStreamComposer;
}

export interface ProcessTurnResult {
  sessionId: string;
  events: ConversationEvent[];
  decision: SelectionDecision;
  outcomes: TurnOutcome[];
  response: RenderableTurn;
  trace: ConversationTrace;
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
}
