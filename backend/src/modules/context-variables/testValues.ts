import { badRequest } from "../../shared/domain/errors.js";
import type { ContextVariable } from "./domain.js";
import { validateValue } from "./valueValidation.js";

/** A caller-provided private value; it never invokes a live resolver. */
export interface TestValue {
  readonly contextVariableId: string;
  readonly value: unknown;
}

/** Immutable metadata and JSON-safe value retained by test and eval executions. */
export interface FrozenTestValue extends TestValue {
  readonly name: string;
  readonly description: string | null;
  /** The label of the option a Choice sample's key names, so Test Chat reads it as a live turn does. */
  readonly label?: string;
  readonly sensitive: boolean;
  readonly trust: "unverified" | "verified";
}

/** The narrow catalog dependency shared by test execution and revision evals. */
export interface ContextVariableTestValueCatalogPort {
  get(workspaceId: string, contextVariableId: string): Promise<ContextVariable | null>;
}

/** A caller maps its immutable revision snapshot into this context-variable selection. */
export interface ContextVariableTestValueSelection {
  readonly variableId: string;
  readonly enabled: boolean;
}

const isJsonValue = (value: unknown, ancestors = new Set<object>()): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = value.every((item) => isJsonValue(item, ancestors));
    ancestors.delete(value);
    return valid;
  }
  if (typeof value !== "object" || value === undefined) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
};

const deepFreeze = <Value>(value: Value): Value => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

const freezeJsonValue = (value: unknown): unknown => deepFreeze(JSON.parse(JSON.stringify(value)));

const acceptTestValue = (definition: ContextVariable, value: unknown): unknown => {
  if (definition.valueType !== "json") {
    if (!validateValue(definition, value).ok) {
      throw badRequest(definition.valueType === "enum"
        ? `Test value for ${definition.name} must be the key of an active option.`
        : `Test value for ${definition.name} must be a string.`);
    }
    return value;
  }
  if (!isJsonValue(value)) throw badRequest(`Test value for ${definition.name} must be JSON-compatible.`);
  return freezeJsonValue(value);
};

/**
 * Validates the immutable selection and freezes private samples for later execution.
 * It deliberately knows neither revision aggregates nor eval/test-execution workflows.
 */
export const freezeTestValues = async (input: {
  workspaceId: string;
  catalog: ContextVariableTestValueCatalogPort;
  selectedEnablements: readonly (readonly ContextVariableTestValueSelection[])[];
  supplied: readonly TestValue[];
}): Promise<readonly FrozenTestValue[]> => {
  const suppliedIds = new Set<string>();
  for (const value of input.supplied) {
    if (suppliedIds.has(value.contextVariableId)) throw badRequest("Duplicate test context-variable reference.");
    suppliedIds.add(value.contextVariableId);
  }

  const enabledBySelection = input.selectedEnablements.map((enablements) =>
    new Set(enablements.filter((item) => item.enabled).map((item) => item.variableId)),
  );
  for (const id of suppliedIds) {
    if (enabledBySelection.some((enabled) => !enabled.has(id))) {
      throw badRequest("A supplied test value is missing from or disabled in a selected revision.");
    }
  }

  const enabledIds = new Set(enabledBySelection.flatMap((enabled) => [...enabled]));
  const definitions = new Map(await Promise.all([...enabledIds].map(async (id) => [id, await input.catalog.get(input.workspaceId, id)] as const)));
  for (const [id, definition] of definitions) {
    if (!definition) throw badRequest("A context-variable definition selected by a revision is unavailable.");
    definitions.set(id, definition);
  }

  return input.supplied.map((value) => {
    const definition = definitions.get(value.contextVariableId);
    if (!definition) throw badRequest("A supplied test context-variable definition is unavailable.");
    const accepted = acceptTestValue(definition, value.value);
    const label = definition.options?.find((option) => option.key === accepted)?.label;
    return Object.freeze({
      contextVariableId: value.contextVariableId,
      value: accepted,
      name: definition.name,
      description: definition.description,
      ...(label !== undefined ? { label } : {}),
      sensitive: definition.sensitivity === "sensitive",
      trust: definition.trustTier === "signed" ? "verified" : "unverified",
    });
  });
};
