import type { ValueSensitivity } from "@radioso/conversation-contract";

import { AppError } from "../../shared/domain/errors.js";
import type { SameType } from "../../shared/types/sameType.js";

import type { ContextVariableSurfacing, ResolvedVariableInput } from "./contextResolutionService.js";
import type { FrozenTestValue } from "./testValues.js";

/**
 * Every type a variable's value can have. Each surface that names a type takes it from here. A value
 * is stored as JSON: a string, any JSON, an option key, a boolean, a finite number, or an ISO calendar
 * date (`YYYY-MM-DD`).
 */
export const CONTEXT_VARIABLE_VALUE_TYPES = ["string", "json", "enum", "boolean", "number", "date"] as const;
export type ContextVariableValueType = typeof CONTEXT_VARIABLE_VALUE_TYPES[number];
export type ContextVariableTrustTier = "unverified" | "signed";
/** The same authored sensitivity a routine slot carries, with the same masking rule. */
export type ContextVariableSensitivity = ValueSensitivity;
/**
 * Every way an agent's variable gets its value. `classified` is a stored value the classifier also
 * keeps: it reads the conversation and picks one of a Choice variable's options.
 */
export const CONTEXT_VARIABLE_SOURCES = ["pushed", "browser", "resolver", "request", "classified"] as const;
export type ContextVariableSource = typeof CONTEXT_VARIABLE_SOURCES[number];
/** Every scope a value can be kept under, the types `context_variable_values.scope_type` accepts. */
export const CONTEXT_VARIABLE_SCOPE_TYPES = ["conversation", "session", "customer", "agent", "workspace"] as const;
export type ContextVariableScopeType = typeof CONTEXT_VARIABLE_SCOPE_TYPES[number];

/**
 * One described choice of an `enum` variable. A stored value holds the key, which never changes;
 * an option is archived rather than removed, so a stored key always names one.
 */
export interface ContextVariableOption {
  key: string;
  label: string;
  description: string | null;
  archived: boolean;
}

export const CONTEXT_VALUE_WRITER_KINDS = ["api", "operator", "routine", "classifier"] as const;
export type ContextValueWriterKind = typeof CONTEXT_VALUE_WRITER_KINDS[number];

/**
 * Who last wrote a value. `ref` names what wrote it: an API credential or user id, a
 * `routineId:executionId`, or a classifier prompt version. A value written before writers were
 * recorded reads as `api` with no reference.
 */
export interface ContextValueWriter {
  kind: ContextValueWriterKind;
  ref: string | null;
}

export interface ContextVariable {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  valueType: ContextVariableValueType;
  /** The choices of an `enum` variable; null for every other type. */
  options: readonly ContextVariableOption[] | null;
  trustTier: ContextVariableTrustTier;
  sensitivity: ContextVariableSensitivity;
  defaultSurfacing: ContextVariableSurfacing;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Whether a source's value lives in the value store, which both resolve paths read: `pushed` (the
 * API, an operator or a routine writes it) and `classified` (the classifier writes it too).
 */
export const readsStoredValue = (source: ContextVariableSource): boolean =>
  source === "pushed" || source === "classified";

/** Why a variable cannot be `classified`: the classifier picks an option, and only for a value it may hold. */
export type ClassificationRefusal = "not_choice" | "private" | "proof";

/** Why an agent cannot classify a variable: the variable's own refusal, or the agent's cap (`too_many`). */
export type ClassificationFitRefusal = ClassificationRefusal | "too_many";

/**
 * Null when the classifier may fill the variable. It fills Choice variables only. It never fills a
 * sensitive one, since an inferred value would be special-category data nobody declared, nor a
 * signed one, since its value comes from what the visitor typed and would pass as proof.
 */
export const classificationRefusal = (
  variable: Pick<ContextVariable, "valueType" | "sensitivity" | "trustTier">,
): ClassificationRefusal | null => {
  if (variable.valueType !== "enum") return "not_choice";
  if (variable.sensitivity === "sensitive") return "private";
  if (variable.trustTier === "signed") return "proof";
  return null;
};

export interface AgentContextVariableEnablement {
  id: string;
  agentId: string;
  variableId: string;
  source: ContextVariableSource;
  resolverSkillId: string | null;
  maxAgeSeconds: number | null;
  resolverTimeoutMs: number | null;
  surfacing: ContextVariableSurfacing;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  variable?: ContextVariable;
}

/** Whether an agent's enablement has the classifier fill its variable: enabled, with source `classified`. */
export const isClassifiedEnablement = (enablement: Pick<AgentContextVariableEnablement, "enabled" | "source">): boolean =>
  enablement.enabled && enablement.source === "classified";

export interface ContextVariableScope {
  type: ContextVariableScopeType;
  id: string;
}

export interface ContextVariableValue {
  id: string;
  workspaceId: string;
  variableId: string;
  scope: ContextVariableScope;
  data: unknown;
  lastModified: Date;
  writtenBy: ContextValueWriter;
}

/**
 * The overwrite rule. The classifier fills a value only when none is stored or it wrote the stored
 * one, so a value an operator, a routine or the host set stays until one of them changes it. Every
 * other writer replaces whatever is stored.
 */
export const mayOverwrite = (existing: ContextValueWriter | null, incomingKind: ContextValueWriterKind): boolean =>
  existing === null || incomingKind !== "classifier" || existing.kind === "classifier";

/**
 * The refusal to change the type of a variable that has values, whose values would no longer be of
 * it. It carries its own code rather than `conflict`: nothing moved under the writer, so a caller
 * that reports a moved target as stale reports this one with its reason.
 */
export const typeChangeWithValuesRefused = (): AppError =>
  new AppError(409, "context_variable_has_values", "The value type of a context variable that has values cannot change");

/**
 * A stored or resolved value as a turn reads it. An enum value keeps its key and carries the label
 * of the option it names, archived or not: a condition matches the label, a prompt shows it, and a
 * skill input bound to the variable receives the key.
 */
export const resolvedVariableInput = (
  enablement: Pick<AgentContextVariableEnablement, "surfacing">,
  variable: ContextVariable,
  value: unknown,
): ResolvedVariableInput => {
  const option = variable.valueType === "enum"
    ? variable.options?.find((candidate) => candidate.key === value)
    : undefined;
  return {
    name: variable.name,
    description: variable.description,
    value,
    ...(option ? { label: option.label } : {}),
    surfacing: enablement.surfacing,
    sensitive: variable.sensitivity === "sensitive",
    trust: variable.trustTier === "signed" ? "verified" : "unverified",
  };
};

/**
 * A frozen Test Chat or eval sample as a turn reads it, under the surfacing of the revision that
 * runs it. A Choice sample keeps the label it was frozen with, so a replay reads it as the test did.
 */
export const frozenTestValueInput = (
  value: FrozenTestValue,
  enablement: Pick<AgentContextVariableEnablement, "surfacing">,
): ResolvedVariableInput => ({
  name: value.name,
  description: value.description,
  value: value.value,
  ...(value.label !== undefined ? { label: value.label } : {}),
  surfacing: enablement.surfacing,
  sensitive: value.sensitive,
  trust: value.trust,
});

/** The keys a turn reads stored values under. */
export interface ContextScopeKeys {
  conversationId: string | null;
  chatSessionId: string | null;
  verifiedCustomerId: string | null;
  agentId: string;
  workspaceId: string;
}

/** The keys of the rungs that hold facts about one conversation. */
export type ConversationScopeKeys = Pick<ContextScopeKeys, "conversationId" | "chatSessionId" | "verifiedCustomerId">;

/**
 * A conversation's own rungs of the ladder, most specific first: what it, the visitor's chat session
 * and the verified customer hold. The agent's and the workspace's rungs below them hold defaults that
 * every conversation of the agent or workspace shares.
 */
export const conversationScopeLadder = (keys: ConversationScopeKeys) => [
  ...(keys.conversationId ? [{ type: "conversation" as const, id: keys.conversationId }] : []),
  ...(keys.chatSessionId ? [{ type: "session" as const, id: keys.chatSessionId }] : []),
  ...(keys.verifiedCustomerId ? [{ type: "customer" as const, id: keys.verifiedCustomerId }] : []),
];
export type ConversationScope = ReturnType<typeof conversationScopeLadder>[number];
export type ConversationScopeType = ConversationScope["type"];

/** The types of a conversation's own rungs, most specific first. Each surface that names one takes it from here. */
export const CONVERSATION_SCOPE_TYPES = ["conversation", "session", "customer"] as const;
// A rung added to conversationScopeLadder fails tsc here until it is listed, and every schema built on the list follows.
const conversationScopeTypesListed: SameType<typeof CONVERSATION_SCOPE_TYPES[number], ConversationScopeType> = true;
void conversationScopeTypesListed;

/** The resolution ladder, most specific first: conversation, session, person, agent, workspace. */
export const contextScopeLadder = (keys: ContextScopeKeys): ContextVariableScope[] => [
  ...conversationScopeLadder(keys),
  { type: "agent", id: keys.agentId },
  { type: "workspace", id: keys.workspaceId },
];

/**
 * Names in this namespace belong to Radioso, not to a workspace. Facts Radioso establishes about a
 * turn are rendered into the same match record as operator-defined variables, and the directive
 * prompts are told they may be relied on — so a workspace variable here would put its value, which
 * can be supplied by the host page at `trustTier: "unverified"`, inside that trust.
 */
export const RESERVED_CONTEXT_VARIABLE_PREFIX = "radioso_";

export const isReservedContextVariableName = (name: string): boolean =>
  name.trim().toLowerCase().startsWith(RESERVED_CONTEXT_VARIABLE_PREFIX);
