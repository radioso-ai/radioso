import {
  planConversationWrite,
  type ConversationValueWriter,
} from "../../src/modules/context-variables/public.js";
import {
  ConversationClassificationService,
  type ClassificationInferenceFactory,
} from "../../src/modules/contextClassification/public.js";
import {
  classificationEvalAttributes,
  type ClassificationEvalCase,
} from "../fixtures/context-classification/cases.js";

/** The classifier over the labelled set's attributes, with the model the caller supplies. */
export const classificationEvalService = (inference: ClassificationInferenceFactory): ConversationClassificationService => {
  const values: ConversationValueWriter = {
    write: async (input) => planConversationWrite({ variable: input.variable, stored: input.stored, data: input.data, writer: input.writtenBy.kind }).outcome,
  };
  return new ConversationClassificationService({
    targets: {
      readConversationTargets: async () => null,
      readDefinitions: async ({ variableIds }) => classificationEvalAttributes.filter((attribute) => variableIds.includes(attribute.id)),
    },
    excerpts: { readExcerpt: async () => null },
    values,
    inference,
  });
};

/** What the classifier chose for each attribute of one case, by attribute name; null for none. */
export const classifyEvalCase = async (
  classifier: Pick<ConversationClassificationService, "classifyTranscript">,
  evalCase: ClassificationEvalCase,
): Promise<Record<string, string | null>> => {
  const values: ConversationValueWriter = {
    write: async (input) => planConversationWrite({ variable: input.variable, stored: input.stored, data: input.data, writer: input.writtenBy.kind }).outcome,
  };
  const result = await classifier.classifyTranscript({
    workspaceId: classificationEvalAttributes[0]!.workspaceId,
    conversationId: evalCase.id,
    agentId: "classification-eval-agent",
    variableIds: classificationEvalAttributes.map((attribute) => attribute.id),
    stored: new Map(),
    excerpt: { summary: evalCase.summary ?? null, messages: evalCase.messages, withheldCount: 0 },
    values,
  });
  return Object.fromEntries(classificationEvalAttributes.map((attribute) => [
    attribute.name,
    result.decisions.find((decision) => decision.variableId === attribute.id)?.value ?? null,
  ]));
};

export interface ClassificationFieldScore {
  name: string;
  expected: Array<string | null>;
  observed: string | null;
  correct: boolean;
}

/** A case is right when every attribute it scores holds an accepted answer. */
export const scoreEvalCase = (
  evalCase: ClassificationEvalCase,
  observed: Record<string, string | null>,
): { passed: boolean; fields: ClassificationFieldScore[] } => {
  const fields = Object.entries(evalCase.expected).map(([name, expected]) => {
    const value = observed[name] ?? null;
    return { name, expected: expected ?? [], observed: value, correct: (expected ?? []).includes(value) };
  });
  return { passed: fields.every((field) => field.correct), fields };
};
