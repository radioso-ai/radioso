import type {
  ConversationDirectiveMatcher,
  ConversationModelGateway,
  ConversationRoutineSkillDispatcher,
  ConversationSkillDispatcher,
  ConversationSkillSelector,
  ConversationTurnComposer,
  ConversationTurnComposeInput,
  Directive,
  DirectiveMatch,
  RenderableTurn,
  RoutineSkillResult,
  SelectionDecision,
  SkillDefinition,
  SkillDispatchResult,
  SkillExecutorPort,
  StagedContext,
  TurnOutcome,
} from "@radioso/conversation-contract";
import {
  AlwaysMatchDirectiveMatcher,
  CompositeDirectiveMatcher,
  ModelDirectiveMatchGateway,
  ProbabilisticDirectiveMatcher,
  createDirectiveBoundSkillSelector,
  noopSkillEmitPort,
  resolveSkillArguments,
  type DirectiveBoundSkillSelectorOptions,
  type DirectiveTextGenerationClient,
} from "@radioso/conversation-defaults";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
};

const selectedSkillNamesFromMetadata = (metadata: Record<string, unknown> | undefined): string[] => {
  if (!metadata) {
    return [];
  }
  const single = typeof metadata.skillName === "string" ? [metadata.skillName] : [];
  return [...single, ...asStringArray(metadata.selectedSkills)];
};

export const createDefaultConversationDirectiveMatcher = (
  modelGateway: ConversationModelGateway,
): ConversationDirectiveMatcher => {
  const textClient: DirectiveTextGenerationClient = {
    async complete(input) {
      const { text } = await modelGateway.complete({
        systemPrompt: input.systemPrompt,
        messages: [{ role: "user", content: input.prompt }],
        metadata: { temperature: input.temperature },
      });
      return { text };
    },
  };
  const matcher = new CompositeDirectiveMatcher([
    new AlwaysMatchDirectiveMatcher(),
    new ProbabilisticDirectiveMatcher({
      gateway: new ModelDirectiveMatchGateway(textClient),
      confidenceThreshold: 0.7,
    }),
  ]);

  return {
    async match(input): Promise<DirectiveMatch[]> {
      return matcher.match({
        turnContext: {
          agent: input.turn.agent,
          sessionId: input.turn.sessionId,
          inputEvent: input.turn.inputEvent,
          history: input.turn.history,
          metadata: input.turn.metadata,
        },
        directives: input.directives,
      });
    },
  };
};

export type DefaultConversationSkillSelectorOptions = DirectiveBoundSkillSelectorOptions;

/**
 * The kit's default terminal skill selection, two rules composed in strict precedence:
 *
 * 1. **Explicit caller override.** When the turn's input metadata names skills
 *    (`skillName` / `selectedSkills`), only those are selected. A host that already
 *    decided which skill runs stays authoritative — including over an authored binding.
 * 2. **Authored binding.** Otherwise the decision comes from
 *    {@link createDirectiveBoundSkillSelector}, verbatim: a matched directive whose
 *    `binding` names a registered, usable skill claims the turn.
 *
 * Both rules are authored/host selection. Neither lets the model free-form pick a
 * tool: nothing claims a turn that a caller did not name or an author did not bind.
 */
export const createDefaultConversationSkillSelector = (
  options: DefaultConversationSkillSelectorOptions = {},
): ConversationSkillSelector => {
  const boundSelector = createDirectiveBoundSkillSelector(options);
  return {
    async select(input): Promise<SelectionDecision> {
      const requested = new Set(selectedSkillNamesFromMetadata(input.turn.inputEvent.metadata));
      if (requested.size === 0) {
        return boundSelector.select(input);
      }
      const selected = input.skills
        .filter((skill) => requested.has(skill.name))
        .map((skill) => ({
          skillName: skill.name,
          reason: "selected_by_input_metadata",
        }));
      const considered = input.skills.map((skill) => ({
        skillName: skill.name,
        selected: requested.has(skill.name),
        reason: requested.has(skill.name) ? "requested_by_input_metadata" : "not_requested",
      }));
      return {
        selected,
        considered,
        reason: selected.length > 0 ? "selected_requested_skills" : "no_skill_requested",
      };
    },
  };
};

export interface LocalSkillHandlerInput {
  skill: SkillDefinition;
  input: Record<string, unknown>;
  sessionId: string;
  message: string;
}

export type LocalSkillHandler = (input: LocalSkillHandlerInput) => Promise<SkillDispatchResult>;

export type LocalSkillRegistry = ReadonlyMap<string, LocalSkillHandler | SkillExecutorPort>;

const dispatchLocalSkill = async (
  handler: LocalSkillHandler | SkillExecutorPort,
  input: LocalSkillHandlerInput,
): Promise<SkillDispatchResult> => {
  if ("dispatch" in handler) {
    return handler.dispatch({
      skill: input.skill,
      collected: input.input,
      context: { sessionId: input.sessionId },
      emit: noopSkillEmitPort,
    });
  }
  return handler(input);
};

export const createDefaultConversationSkillDispatcher = (
  handlers: LocalSkillRegistry = new Map(),
): ConversationSkillDispatcher => ({
  async dispatch({ skill, selected, turn }): Promise<TurnOutcome> {
    const handler = handlers.get(skill.name);
    if (!handler) {
      return {
        kind: "generic",
        skillName: skill.name,
        outcome: {
          status: "failed",
          error: {
            code: "local_skill_not_registered",
            message: `No local skill handler is registered for "${skill.name}".`,
            retryable: false,
          },
        },
        stagedContext: [],
        steering: turn.steering,
        trace: {
          traceId: `conversation-kit-skill-${skill.name}`,
          startedAt: new Date().toISOString(),
          stages: [],
        },
      };
    }
    const result = await dispatchLocalSkill(handler, {
      skill,
      input: isRecord(selected.input) ? selected.input : {},
      sessionId: turn.sessionId,
      message: turn.inputEvent.content,
    });
    if (result.disposition === "deferred") {
      return {
        kind: "generic",
        skillName: skill.name,
        outcome: {
          status: "awaiting_tool",
          outputs: { ticketId: result.ticket.ticketId },
        },
        stagedContext: [],
        steering: turn.steering,
        trace: {
          traceId: `conversation-kit-skill-${skill.name}`,
          startedAt: new Date().toISOString(),
          stages: [],
        },
      };
    }
    return {
      kind: "generic",
      skillName: skill.name,
      outcome: result.outcome,
      stagedContext: [{ kind: "local_skill", id: skill.name, data: result.outcome.outputs ?? {} }],
      steering: turn.steering,
      trace: {
        traceId: `conversation-kit-skill-${skill.name}`,
        startedAt: new Date().toISOString(),
        stages: [],
      },
    };
  },
});

const contextVariableName = (staged: StagedContext): string | null => {
  const fromMetadata = isRecord(staged.metadata) && typeof staged.metadata.variableName === "string"
    ? staged.metadata.variableName
    : null;
  const name = fromMetadata ?? (typeof staged.id === "string" ? staged.id : null);
  return name && name.trim().length > 0 ? name : null;
};

/**
 * The turn's context variables as a plain record, for `contextVariableRef` bindings.
 * Deliberately generic: a staged entry either carries a `{ kind: "variable", value }`
 * envelope or is the value itself. Hosts with product-specific context shapes resolve
 * those themselves and pass their own record.
 */
const contextValuesFromStagedContext = (stagedContext: readonly StagedContext[]): Record<string, unknown> => {
  const contextValues: Record<string, unknown> = {};
  for (const staged of stagedContext) {
    if (staged.kind !== "context_variable") {
      continue;
    }
    const name = contextVariableName(staged);
    if (!name) {
      continue;
    }
    contextValues[name] = isRecord(staged.data) && staged.data.kind === "variable" && "value" in staged.data
      ? staged.data.value
      : staged.data;
  }
  return contextValues;
};

// A recoverable failure the runner can branch on. A routine runs on a resumable state
// machine and this is resolved BEFORE the turn is persisted, so throwing would fail the
// turn AND pin the routine at this step — re-throwing on every later turn, permanently
// wedging the conversation. An unresolvable, unhandled, or failing skill is an
// author/config error, not a programming bug, so it degrades to a `failed` result the
// runner advances off (an outcome-guarded edge or the step's first follow-up).
const routineSkillUnavailable = (skillName: string, reason: string): RoutineSkillResult => ({
  status: "failed",
  outputs: { skill: skillName, reason },
  metadata: { skillName, reason },
});

/**
 * Dispatches a routine `skill` step against the same local skill handlers the turn
 * dispatcher uses: the step's `skillName` resolves to a registered {@link SkillDefinition}
 * and its handler, authored `inputBindings` resolve to the handler's arguments, and the
 * settled outcome is projected onto the {@link RoutineSkillResult} the runner branches on.
 * It never throws.
 */
export const createDefaultRoutineSkillDispatcher = (
  handlers: LocalSkillRegistry = new Map(),
  skills: readonly SkillDefinition[] = [],
): ConversationRoutineSkillDispatcher => ({
  async dispatch({ skillName, state, turn, inputBindings }): Promise<RoutineSkillResult> {
    const skill = skills.find((candidate) => candidate.name === skillName);
    if (!skill) {
      return routineSkillUnavailable(skillName, "unknown_skill");
    }
    const handler = handlers.get(skillName);
    if (!handler) {
      return routineSkillUnavailable(skillName, "local_skill_not_registered");
    }

    // An untyped step authors no bindings, so it hands the handler the routine's
    // collected variables wholesale; a typed step gets exactly what it bound. Same
    // split the Radioso host makes, so a routine dispatches identically either side
    // of the kit boundary.
    const variables = state.variables ?? {};
    const collected = inputBindings && Object.keys(inputBindings).length > 0
      ? resolveSkillArguments(inputBindings, variables, contextValuesFromStagedContext(turn.stagedContext))
      : variables;

    let result: SkillDispatchResult;
    try {
      result = await dispatchLocalSkill(handler, {
        skill,
        input: collected,
        sessionId: turn.sessionId,
        message: turn.inputEvent.content,
      });
    } catch {
      return routineSkillUnavailable(skillName, "handler_error");
    }

    if (result.disposition !== "settled") {
      // Reconciling a deferred result in a later turn is not wired for routines, so the
      // step degrades rather than parking the routine on a result that never arrives.
      return routineSkillUnavailable(skillName, "deferred");
    }

    return {
      status: result.outcome.status,
      ...(result.outcome.outputs ? { outputs: result.outcome.outputs } : {}),
      ...(result.outcome.answer ? { answer: result.outcome.answer } : {}),
      ...(result.outcome.metadata ? { metadata: result.outcome.metadata } : {}),
    };
  },
});

const formatJson = (value: unknown): string => JSON.stringify(value, null, 2);

const createSystemPrompt = (input: ConversationTurnComposeInput): string => {
  const sections: string[] = [
    "You are running inside @radioso/conversation-kit, a standalone conversation engine host.",
  ];
  if (input.turn.agent.name) {
    sections.push(`Agent name: ${input.turn.agent.name}`);
  }
  if (input.turn.agent.instructions && input.turn.agent.instructions.length > 0) {
    sections.push(`Agent instructions:\n${input.turn.agent.instructions.map((instruction) => `- ${instruction}`).join("\n")}`);
  }
  if (input.turn.steering.length > 0) {
    sections.push(`Active steering rules:\n${input.turn.steering.map((rule) => `- ${rule.action}`).join("\n")}`);
  }
  if (input.outcomes.length > 0) {
    sections.push(`Completed skill outcomes:\n${formatJson(input.outcomes.map((outcome) => ({
      skillName: outcome.skillName,
      status: outcome.outcome.status,
      answer: outcome.outcome.answer,
      outputs: outcome.outcome.outputs,
    })))}`);
  }
  sections.push("Use the conversation history, current user message, steering rules, and skill outcomes to write the assistant reply.");
  return sections.join("\n\n");
};

export const createModelBackedConversationComposer = (
  modelGateway: ConversationModelGateway,
): ConversationTurnComposer => ({
  async compose(input): Promise<RenderableTurn> {
    const { text, metadata } = await modelGateway.complete({
      systemPrompt: createSystemPrompt(input),
      messages: [
        ...input.turn.history,
        {
          role: "user",
          content: input.turn.inputEvent.content,
          metadata: input.turn.inputEvent.metadata,
        },
      ],
      metadata: {
        sessionId: input.turn.sessionId,
        agentId: input.turn.agent.id,
        selectedSkills: input.decision.selected.map((selected) => selected.skillName),
      },
    });
    return {
      answer: text,
      metadata,
    };
  },
});

export type { SkillDispatchResult, SkillExecutorPort };
