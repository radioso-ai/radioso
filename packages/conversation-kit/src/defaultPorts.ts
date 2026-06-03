import type {
  ConversationDirectiveMatcher,
  ConversationModelGateway,
  ConversationSkillDispatcher,
  ConversationSkillSelector,
  ConversationTurnComposer,
  ConversationTurnComposeInput,
  Directive,
  DirectiveMatch,
  RenderableTurn,
  SelectionDecision,
  SkillDefinition,
  TurnOutcome,
} from "@radioso/conversation-contract";
import {
  AlwaysMatchDirectiveMatcher,
  CompositeDirectiveMatcher,
  ModelDirectiveMatchGateway,
  ProbabilisticDirectiveMatcher,
  noopSkillEmitPort,
  type DirectiveTextGenerationClient,
  type SkillDispatchResult,
  type SkillExecutorPort,
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

export const createDefaultConversationSkillSelector = (): ConversationSkillSelector => ({
  async select(input): Promise<SelectionDecision> {
    const requested = new Set(selectedSkillNamesFromMetadata(input.turn.inputEvent.metadata));
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
});

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
