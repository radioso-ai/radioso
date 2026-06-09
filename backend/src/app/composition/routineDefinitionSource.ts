import type { ConversationModelGateway, TurnContext } from "@radioso/conversation-contract";

import type { RoutineRegistration } from "../../modules/chat/composition.js";
import type { RoutineDefinitionRepository } from "../../db/repositories/routineDefinitionRepository.js";
import { compileRoutineDefinition } from "../../modules/routines/public.js";

export interface PublishedRoutineRegistrationSource {
  load(input: { agentId: string }): Promise<RoutineRegistration[]>;
}

const parseActivationDecision = (text: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Boolean(
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "activate" in parsed &&
      parsed.activate === true,
    );
  } catch {
    return false;
  }
};

const activationPrompt = (triggerDescription: string, gateRef: string | null): string =>
  [
    "Decide whether the routine should activate for the current user turn.",
    "Return only compact JSON with a boolean field named activate.",
    `Trigger: ${triggerDescription}`,
    gateRef ? `Gate: ${gateRef}` : null,
  ].filter((line): line is string => line !== null).join("\n");

const activateWithTrigger = async (
  input: {
    turn: TurnContext;
    modelGateway: ConversationModelGateway;
    triggerDescription: string;
    gateRef: string | null;
  },
): Promise<{ variables?: Record<string, unknown> } | null> => {
  const decision = await input.modelGateway.complete({
    systemPrompt: activationPrompt(input.triggerDescription, input.gateRef),
    messages: [
      {
        role: "user",
        content: input.turn.inputEvent.content,
      },
    ],
    metadata: {
      routineActivation: true,
      agentId: input.turn.agent.id,
    },
  });
  return parseActivationDecision(decision.text) ? {} : null;
};

export const createPublishedRoutineRegistrationSource = (
  repository: Pick<RoutineDefinitionRepository, "listPublishedByAgent">,
): PublishedRoutineRegistrationSource => ({
  async load({ agentId }) {
    const definitions = await repository.listPublishedByAgent(agentId);
    return definitions.map((definition) => ({
      routine: compileRoutineDefinition(definition),
      activates: ({ turn, modelGateway }) =>
        activateWithTrigger({
          turn,
          modelGateway,
          triggerDescription: definition.activation.triggerDescription,
          gateRef: definition.activation.gateRef,
        }),
    }));
  },
});
