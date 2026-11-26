import { z } from "zod";

import { unstoredConversationUsage, type ModelCallUsageAttribution } from "../../../shared/domain/modelCallUsageContext.js";
import type { AgentRevision } from "../../agents/public.js";
import {
  CONTEXT_VALUE_WRITER_KINDS,
  frozenTestValueInput,
  isClassifiedEnablement,
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

/** What a Test Chat side carries of its attributes from one turn to the next, in its continuation. */
export interface TestChatAttributeState {
  readonly values: readonly TestChatAttributeValue[];
  /**
   * The ids of the side's messages from turns whose routine held a sensitive slot. Classification
   * never reads them, as live chat never sends a message it marked.
   */
  readonly withheldMessageIds: readonly string[];
}

/**
 * What a Test Chat turn's trace shows of the side's classified attributes after the turn: every one
 * the revision classifies, with its value, its option label, and who set it — the classifier, or
 * the operator through a sample — or `value: null, writtenBy: null` when it holds none. Test Chat is
 * the operator's own private test, so its values are shown; a customer conversation's trace never
 * carries this.
 */
export interface TestChatAttributesPreview {
  outcome: ClassificationRunOutcome;
  values: Array<{ name: string; value: string | null; label?: string; writtenBy: "classifier" | "operator" | null }>;
}

/**
 * How a Test Chat attempt's model calls are metered: under Test Chat's own surface, named by the
 * attempt rather than by the side's conversation and message, which the ledger holds no row for.
 */
export const testChatUsageAttribution = (attemptId: string): ModelCallUsageAttribution => unstoredConversationUsage("test_execution", attemptId);

/** The classifier's entry for a caller that holds the conversation itself. */
type TestChatClassifier = Pick<ConversationClassificationService, "readDefinitions" | "classifyTranscript">;

/**
 * How long a Test Chat turn waits for its classification once the answer is out. A run past it
 * is aborted, and the side keeps the values it held (`skipped_timeout`).
 */
const TEST_CHAT_CLASSIFICATION_TIMEOUT_MS = 5_000;

/** The most withheld ids a side carries; the classifier reads only the latest few messages. */
const MAX_WITHHELD_MESSAGE_IDS = 100;

const classifiedVariableIds = (revision: AgentRevision): string[] =>
  revision.snapshot.contextVariableEnablements
    .filter(isClassifiedEnablement)
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

/** Settles once `signal` aborts: the bound a turn waits on its classification. */
const abortOf = (signal: AbortSignal): Promise<"timed_out"> =>
  new Promise((resolve) => signal.addEventListener("abort", () => resolve("timed_out"), { once: true }));

/**
 * Classifies a Test Chat turn as a live conversation is classified after its turn commits. A test
 * side is not a stored conversation, so this runs in the trusted runner, after the replayed turn has
 * answered, over the side's own transcript (the operator's messages, and a seed's, which the seed
 * already withholds where marked), against the values the test holds: its samples, which count as
 * the operator's, and what the classifier wrote on earlier turns. The overwrite rule is the store's
 * own (`planConversationWrite`).
 *
 * A turn whose routine held a sensitive slot is not classified, and its message is withheld from
 * every later turn's run, as live chat withholds a message it marked. A run is bounded by
 * `timeoutMs` and by the turn's own signal; a failed or timed-out run never fails the turn: the test
 * keeps the values it held. Null when the revision classifies nothing.
 */
export const classifyTestChatTurn = async (input: {
  classifier: TestChatClassifier;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  revision: AgentRevision;
  history: readonly TestExecutionHistoryEntry[];
  message: string;
  /** The id the side's transcript stores `message` under. */
  userMessageId?: string;
  samples: readonly FrozenTestValue[];
  previous: TestChatAttributeState;
  /** The sensitive slots the replayed turn's routine held. */
  sensitiveSlotKeys: readonly string[];
  /** The attempt the run belongs to: its model call is metered under it, with no conversation link. */
  attemptId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ state: TestChatAttributeState; trace: TestChatAttributesPreview } | null> => {
  const variableIds = classifiedVariableIds(input.revision);
  if (variableIds.length === 0) return null;
  const samples = new Map(input.samples.filter((sample) => variableIds.includes(sample.contextVariableId)).map((sample) => [sample.contextVariableId, sample]));
  const previous = input.previous.values.filter((value) => variableIds.includes(value.contextVariableId) && !samples.has(value.contextVariableId));
  const heldSensitiveSlot = input.sensitiveSlotKeys.length > 0;
  const withheldMessageIds = heldSensitiveSlot && input.userMessageId
    ? [...input.previous.withheldMessageIds, input.userMessageId].slice(-MAX_WITHHELD_MESSAGE_IDS)
    : [...input.previous.withheldMessageIds];
  const held = new Map<string, TestChatAttributeValue>(previous.map((value) => [value.contextVariableId, value]));
  let variables: ContextVariable[] = [];
  let outcome: ClassificationRunOutcome;
  try {
    variables = await input.classifier.readDefinitions({ workspaceId: input.workspaceId, variableIds });
    outcome = heldSensitiveSlot ? "skipped_sensitive" : await classify({ ...input, variables, samples, previous, held, withheldMessageIds });
  } catch {
    outcome = "failed";
  }
  if (outcome === "failed" || outcome === "invalid" || outcome === "skipped_timeout") {
    held.clear();
    for (const value of previous) held.set(value.contextVariableId, value);
  }
  return {
    state: { values: [...held.values()], withheldMessageIds },
    trace: { outcome, values: attributesPreview(variableIds, variables, samples, held, previous) },
  };
};

/** One bounded run over the side's sendable messages, writing into `held` through the store's overwrite rule. */
const classify = async (input: {
  classifier: TestChatClassifier;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  history: readonly TestExecutionHistoryEntry[];
  message: string;
  variables: readonly ContextVariable[];
  samples: ReadonlyMap<string, FrozenTestValue>;
  previous: readonly TestChatAttributeValue[];
  held: Map<string, TestChatAttributeValue>;
  withheldMessageIds: readonly string[];
  attemptId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ClassificationRunOutcome> => {
  const stored = new Map<string, StoredConversationValue>([
    ...[...input.samples.values()].map((sample) => [sample.contextVariableId, { data: sample.value, writtenBy: { kind: "operator", ref: null } }] as const),
    ...input.previous.map((value) => [value.contextVariableId, { data: value.value, writtenBy: value.writtenBy }] as const),
  ]);
  const values: ConversationValueWriter = {
    write: async ({ variable, stored: read, data, writtenBy }) => {
      const plan = planConversationWrite({ variable, stored: read, data, writer: writtenBy.kind });
      if (plan.action === "store" && typeof data === "string") input.held.set(variable.id, frozenValue(variable, data, writtenBy));
      if (plan.action === "clear") input.held.delete(variable.id);
      return plan.outcome;
    },
  };
  const withheld = new Set(input.withheldMessageIds);
  const sendable = input.history.filter((entry) => entry.role === "user" && !(entry.messageId && withheld.has(entry.messageId)));
  const timeout = AbortSignal.timeout(input.timeoutMs ?? TEST_CHAT_CLASSIFICATION_TIMEOUT_MS);
  const run = input.classifier.classifyTranscript({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    variables: input.variables,
    stored,
    excerpt: {
      summary: null,
      messages: [...sendable.map((entry) => entry.content), input.message],
      withheldCount: input.history.filter((entry) => entry.role === "user").length - sendable.length,
    },
    values,
    usageAttribution: testChatUsageAttribution(input.attemptId),
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  });
  // A provider that ignores the abort still cannot hold the turn past the bound.
  const settled = await Promise.race([run, abortOf(timeout)]);
  return settled === "timed_out" ? "skipped_timeout" : settled.outcome;
};

/** Every attribute the revision classifies, in the definitions' order, with what the side holds for it. */
const attributesPreview = (
  variableIds: readonly string[],
  variables: readonly ContextVariable[],
  samples: ReadonlyMap<string, FrozenTestValue>,
  held: ReadonlyMap<string, TestChatAttributeValue>,
  previous: readonly TestChatAttributeValue[],
): TestChatAttributesPreview["values"] => {
  const names = new Map<string, string>([...samples.values(), ...previous].map((value) => [value.contextVariableId, value.name]));
  for (const variable of variables) names.set(variable.id, variable.name);
  const ordered = [...variables.map((variable) => variable.id), ...variableIds.filter((id) => !variables.some((variable) => variable.id === id))];
  return ordered.flatMap((variableId): TestChatAttributesPreview["values"] => {
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
  });
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
    (candidate) => candidate.variableId === value.contextVariableId && isClassifiedEnablement(candidate),
  );
  return enablement ? [frozenTestValueInput(value, enablement)] : [];
});
