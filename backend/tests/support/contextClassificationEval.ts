import {
  planConversationWrite,
  type ConversationValueWriteOutcome,
  type ConversationValueWriter,
  type StoredConversationValue,
} from "../../src/modules/context-variables/public.js";
import {
  CONTEXT_CLASSIFICATION_PROMPT_VERSION,
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

/** What the classifier chose for each attribute of one case, and what writing it did, by attribute name. */
export interface ClassificationEvalObservation {
  values: Record<string, string | null>;
  writes: Record<string, ConversationValueWriteOutcome>;
}

/** Classifies one case against the values the classifier set on its earlier turns (`previous`). */
export const classifyEvalCase = async (
  classifier: Pick<ConversationClassificationService, "classifyTranscript">,
  evalCase: ClassificationEvalCase,
): Promise<ClassificationEvalObservation> => {
  const values: ConversationValueWriter = {
    write: async (input) => planConversationWrite({ variable: input.variable, stored: input.stored, data: input.data, writer: input.writtenBy.kind }).outcome,
  };
  const stored = new Map<string, StoredConversationValue>(classificationEvalAttributes.flatMap((attribute) => {
    const previous = evalCase.previous?.[attribute.name as keyof NonNullable<ClassificationEvalCase["previous"]>];
    return previous ? [[attribute.id, { data: previous, writtenBy: { kind: "classifier" as const, ref: CONTEXT_CLASSIFICATION_PROMPT_VERSION } }]] : [];
  }));
  const result = await classifier.classifyTranscript({
    workspaceId: classificationEvalAttributes[0].workspaceId,
    conversationId: evalCase.id,
    agentId: "classification-eval-agent",
    variables: classificationEvalAttributes,
    stored,
    excerpt: { summary: evalCase.summary ?? null, messages: evalCase.messages, withheldCount: 0 },
    values,
  });
  const decisionOf = (id: string) => result.decisions.find((decision) => decision.variableId === id);
  return {
    values: Object.fromEntries(classificationEvalAttributes.map((attribute) => [attribute.name, decisionOf(attribute.id)?.value ?? null])),
    writes: Object.fromEntries(classificationEvalAttributes.flatMap((attribute) => {
      const write = decisionOf(attribute.id)?.write;
      return write ? [[attribute.name, write]] : [];
    })),
  };
};

export interface ClassificationFieldScore {
  name: string;
  expected: Array<string | null>;
  observed: string | null;
  correct: boolean;
}

/**
 * A case is right when every attribute it scores holds an accepted answer. An attribute the
 * classifier set on an earlier turn (`previous`) and the case expects to hold nothing must have been
 * cleared, not merely left out of the call.
 */
export const scoreEvalCase = (
  evalCase: ClassificationEvalCase,
  observed: ClassificationEvalObservation,
): { passed: boolean; fields: ClassificationFieldScore[] } => {
  const fields = Object.entries(evalCase.expected).map(([name, expected]) => {
    const value = observed.values[name] ?? null;
    const mustClear = evalCase.previous?.[name as keyof NonNullable<ClassificationEvalCase["previous"]>] !== undefined && value === null;
    const correct = (expected ?? []).includes(value) && (!mustClear || observed.writes[name] === "cleared");
    return { name, expected: expected ?? [], observed: value, correct };
  });
  return { passed: fields.every((field) => field.correct), fields };
};

/** Tokens a model call used, as its provider reported them; zero where it reported none. */
export interface ClassificationEvalTokenUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The inference factory over `pipeline`, adding every call's reported tokens to `usage`, so a live
 * run can say what it cost.
 */
export const meteredInference = (
  pipeline: Awaited<ReturnType<ClassificationInferenceFactory["create"]>>,
  usage: ClassificationEvalTokenUsage,
): ClassificationInferenceFactory => ({
  create: async () => ({
    complete: async (request) => {
      const result = await pipeline.complete(request);
      usage.calls += 1;
      usage.inputTokens += result.usage?.inputTokens ?? 0;
      usage.outputTokens += result.usage?.outputTokens ?? 0;
      return result;
    },
  }),
});
