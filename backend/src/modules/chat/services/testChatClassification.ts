import { z } from "zod";

import type { AgentRevision } from "../../agents/public.js";
import {
  CONTEXT_VALUE_WRITER_KINDS,
  frozenTestValueInput,
  planConversationWrite,
  type ContextValueWriter,
  type ContextVariable,
  type ConversationValueWriter,
  type FrozenTestValue,
  type ResolvedVariableInput,
  type StoredConversationValue,
} from "../../context-variables/public.js";
import type { ClassificationRunOutcome, ConversationClassificationService } from "../../contextClassification/public.js";
import type { TestExecutionHistoryEntry } from "../../test-execution/public.js";

/**
 * A value the classifier wrote in a Test Chat side, carried in the side's continuation to its next
 * turn the way a frozen sample is carried: with the definition it was written under.
 */
export const testChatAttributeValueSchema = z.object({
  contextVariableId: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  value: z.string(),
  label: z.string().optional(),
  sensitive: z.boolean(),
  trust: z.enum(["unverified", "verified"]),
  writtenBy: z.object({ kind: z.enum(CONTEXT_VALUE_WRITER_KINDS), ref: z.string().nullable() }).strict(),
}).strict();

export type TestChatAttributeValue = FrozenTestValue & { readonly writtenBy: ContextValueWriter };

/**
 * What a Test Chat turn's trace shows of the side's classified attributes after the turn: each one's
 * value, its option label, and who set it — the classifier, or the operator through a sample.
 * Test Chat is the operator's own private test, so its values are shown; a customer conversation's
 * trace never carries this.
 */
export interface TestChatAttributesPreview {
  outcome: ClassificationRunOutcome;
  values: Array<{ name: string; value: string | null; label?: string; writtenBy: "classifier" | "operator" | null }>;
}

const classifiedVariableIds = (revision: AgentRevision): string[] =>
  revision.snapshot.contextVariableEnablements
    .filter((enablement) => enablement.enabled && enablement.source === "classified")
    .map((enablement) => enablement.variableId);

const frozenValue = (variable: ContextVariable, value: string, writtenBy: ContextValueWriter): TestChatAttributeValue => {
  const label = variable.options?.find((option) => option.key === value)?.label;
  return {
    contextVariableId: variable.id,
    name: variable.name,
    description: variable.description,
    value,
    ...(label !== undefined ? { label } : {}),
    sensitive: variable.sensitivity === "sensitive",
    trust: variable.trustTier === "signed" ? "verified" : "unverified",
    writtenBy,
  };
};

/**
 * Classifies a Test Chat turn as a live conversation is classified after its turn. A test side is
 * not a stored conversation, so this runs in the trusted runner over the side's own transcript (the
 * operator's messages, and a seed's, which the seed already withholds where marked), against the
 * values the test holds: its samples, which count as the operator's, and what the classifier wrote
 * on earlier turns. The overwrite rule is the store's own (`planConversationWrite`). A failed run
 * never fails the turn: the test keeps the values it held. Null when the revision classifies nothing.
 */
export const classifyTestChatTurn = async (input: {
  classifier: Pick<ConversationClassificationService, "classifyTranscript">;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  revision: AgentRevision;
  history: readonly TestExecutionHistoryEntry[];
  message: string;
  samples: readonly FrozenTestValue[];
  previous: readonly TestChatAttributeValue[];
  signal?: AbortSignal;
}): Promise<{ values: TestChatAttributeValue[]; trace: TestChatAttributesPreview } | null> => {
  const variableIds = classifiedVariableIds(input.revision);
  if (variableIds.length === 0) return null;
  const samples = new Map(input.samples.filter((sample) => variableIds.includes(sample.contextVariableId)).map((sample) => [sample.contextVariableId, sample]));
  const previous = input.previous.filter((value) => variableIds.includes(value.contextVariableId) && !samples.has(value.contextVariableId));
  const names = new Map([...samples.values(), ...previous].map((value) => [value.contextVariableId, value.name]));
  const held = new Map<string, TestChatAttributeValue>(previous.map((value) => [value.contextVariableId, value]));
  const stored = new Map<string, StoredConversationValue>([
    ...[...samples.values()].map((sample) => [sample.contextVariableId, { data: sample.value, writtenBy: { kind: "operator", ref: null } }] as const),
    ...previous.map((value) => [value.contextVariableId, { data: value.value, writtenBy: value.writtenBy }] as const),
  ]);
  const values: ConversationValueWriter = {
    write: async ({ variable, stored: read, data, writtenBy }) => {
      names.set(variable.id, variable.name);
      const plan = planConversationWrite({ variable, stored: read, data, writer: writtenBy.kind });
      if (plan.action === "store" && typeof data === "string") held.set(variable.id, frozenValue(variable, data, writtenBy));
      if (plan.action === "clear") held.delete(variable.id);
      return plan.outcome;
    },
  };
  let outcome: ClassificationRunOutcome;
  try {
    outcome = (await input.classifier.classifyTranscript({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      variableIds,
      stored,
      excerpt: {
        summary: null,
        messages: [...input.history.filter((entry) => entry.role === "user").map((entry) => entry.content), input.message],
        withheldCount: 0,
      },
      values,
      ...(input.signal ? { signal: input.signal } : {}),
    })).outcome;
  } catch {
    outcome = "failed";
    held.clear();
    for (const value of previous) held.set(value.contextVariableId, value);
  }
  return {
    values: [...held.values()],
    trace: {
      outcome,
      values: variableIds.flatMap((variableId): TestChatAttributesPreview["values"] => {
        const name = names.get(variableId);
        if (!name) return [];
        const sample = samples.get(variableId);
        const value = sample ?? held.get(variableId);
        if (!value) return [{ name, value: null, writtenBy: null }];
        return [{
          name,
          value: typeof value.value === "string" ? value.value : null,
          ...(value.label !== undefined ? { label: value.label } : {}),
          writtenBy: sample ? "operator" : "classifier",
        }];
      }),
    },
  };
};

/**
 * The classifier's values as the next turn reads them, under the surfacing of the revision the side
 * runs, the way its samples are read. A sample for the same attribute is the operator's and wins.
 */
export const testChatAttributeInputs = (
  values: readonly TestChatAttributeValue[],
  samples: readonly FrozenTestValue[],
  revision: AgentRevision,
): ResolvedVariableInput[] => values.flatMap((value) => {
  if (samples.some((sample) => sample.contextVariableId === value.contextVariableId)) return [];
  const enablement = revision.snapshot.contextVariableEnablements.find(
    (candidate) => candidate.variableId === value.contextVariableId && candidate.enabled && candidate.source === "classified",
  );
  return enablement ? [frozenTestValueInput(value, enablement)] : [];
});
