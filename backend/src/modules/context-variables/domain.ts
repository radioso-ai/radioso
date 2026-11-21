import type { ValueSensitivity } from "@radioso/conversation-contract";

import { AppError } from "../../shared/domain/errors.js";

import type { ContextVariableSurfacing, ResolvedVariableInput } from "./contextResolutionService.js";
import type { FrozenTestValue } from "./testValues.js";

export type ContextVariableValueType = "string" | "json" | "enum";
export type ContextVariableTrustTier = "unverified" | "signed";
/** The same authored sensitivity a routine slot carries, with the same masking rule. */
export type ContextVariableSensitivity = ValueSensitivity;
export type ContextVariableSource = "pushed" | "browser" | "resolver" | "request";
export type ContextVariableScopeType = "conversation" | "session" | "customer" | "agent" | "workspace";

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

/** The resolution ladder, most specific first: conversation, session, person, agent, workspace. */
export const contextScopeLadder = (keys: ContextScopeKeys): ContextVariableScope[] => [
  ...(keys.conversationId ? [{ type: "conversation" as const, id: keys.conversationId }] : []),
  ...(keys.chatSessionId ? [{ type: "session" as const, id: keys.chatSessionId }] : []),
  ...(keys.verifiedCustomerId ? [{ type: "customer" as const, id: keys.verifiedCustomerId }] : []),
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
