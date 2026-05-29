import type { SteeringRule } from "../../shared/domain/steeringRule.js";

import type { SkillDefinition, SkillExecution, SkillOutcomeStatus } from "./domain.js";

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
 * pass {@link noopSkillEmitPort}.
 */
export interface SkillEmitPort {
  emitStatus(status: string, data?: Record<string, unknown>): Promise<void>;
  emitCustom(data: Record<string, unknown>): Promise<void>;
}

/** Everything a skill executor needs for a single dispatch. */
export interface SkillInvocation {
  skill: SkillDefinition;
  collected: Record<string, unknown>;
  context?: Record<string, unknown>;
  /** Interim-event channel for the current turn. */
  emit: SkillEmitPort;
  /** Cancels in-flight work when the turn is abandoned (new input, shutdown). */
  signal?: AbortSignal;
}

/** Control bits a skill returns to steer the rest of the turn or the session. */
export interface SkillOutcomeControl {
  /** Flip the session between AI-managed and human-managed (handoff). */
  sessionMode?: "automatic" | "manual";
  /** Whether the outcome is valid for this response only or the whole session. */
  lifespan?: "response" | "session";
}

/**
 * Transient, single-turn steering a skill can inject (condition/action pair).
 * This is a {@link SteeringRule} without the loop-assigned provenance fields:
 * the executor emits the bare rule and the turn loop tags `source`/`lifespan`
 * when it merges skill-emitted guidance with authored Directives into one set.
 */
export type SkillTransientGuidance = Omit<SteeringRule, "source" | "lifespan">;

// Compile-time guard: fails the build if the skill-emitted guidance shape ever
// drifts from SteeringRule's authored fields. Authored Directives and skill
// guidance MUST stay one shape.
type _GuidanceMatchesSteering = SkillTransientGuidance extends Omit<SteeringRule, "source" | "lifespan">
  ? Omit<SteeringRule, "source" | "lifespan"> extends SkillTransientGuidance
    ? true
    : never
  : never;
const _guidanceMatchesSteering: _GuidanceMatchesSteering = true;
void _guidanceMatchesSteering;

/**
 * The outcome of a skill dispatch: a steering envelope, not a bare answer.
 * `answer` and `outputs` are seen by the model; `metadata` is frontend-only and
 * not shown to the model.
 */
export interface SkillOutcome {
  status: SkillOutcomeStatus;
  answer?: string;
  outputs?: Record<string, unknown>;
  control?: SkillOutcomeControl;
  guidance?: SkillTransientGuidance[];
  metadata?: Record<string, unknown>;
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

/** Emit port for call sites that have no live session to append events to. */
export const noopSkillEmitPort: SkillEmitPort = {
  async emitStatus() {},
  async emitCustom() {},
};

export type SkillExecutorDescriptor =
  | { kind: "internal"; adapter: string }
  | { kind: "delivery_pipeline"; adapter: string }
  | { kind: "webhook"; provider: "make" | "zapier" | "custom" };

export type SkillExecutorRegistration = SkillExecutorDescriptor & {
  executor: SkillExecutorPort;
};

const keyForDescriptor = (descriptor: SkillExecutorDescriptor): string => {
  switch (descriptor.kind) {
    case "internal":
    case "delivery_pipeline":
      return `${descriptor.kind}:${descriptor.adapter}`;
    case "webhook":
      return `webhook:${descriptor.provider}`;
  }
};

const keyForExecution = (execution: SkillExecution): string => {
  switch (execution.kind) {
    case "internal":
    case "delivery_pipeline":
      return `${execution.kind}:${execution.adapter}`;
    case "webhook":
      return `webhook:${execution.provider}`;
  }
};

export class SkillExecutorRegistry {
  private readonly executors = new Map<string, SkillExecutorPort>();

  constructor(registrations: SkillExecutorRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  register(registration: SkillExecutorRegistration): void {
    const { executor, ...descriptor } = registration;
    const key = keyForDescriptor(descriptor);
    if (this.executors.has(key)) {
      throw new Error(`Skill executor for ${key} is already registered`);
    }
    this.executors.set(key, executor);
  }

  resolve(execution: SkillExecution): SkillExecutorPort | null {
    return this.executors.get(keyForExecution(execution)) ?? null;
  }
}
