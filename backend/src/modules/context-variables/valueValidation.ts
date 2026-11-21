import { CONTEXT_VARIABLES_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";
import type { ContextVariable, ContextVariableOption, ContextVariableValueType } from "./domain.js";

type Verdict<Code extends string> = { ok: true } | { ok: false; code: Code };

export type ValueValidationCode = "type_mismatch" | "unknown_option" | "archived_option";

const accepted = { ok: true } as const;
const refused = <Code extends string>(code: Code): Verdict<Code> => ({ ok: false, code });

/**
 * Whether `data` may be written as the value of a variable. Every writer goes through it. An enum
 * value is the key of an active option; an archived key stays valid where it is already stored, so a
 * reader of stored values treats `archived_option` as readable.
 */
export const validateValue = (
  definition: Pick<ContextVariable, "valueType" | "options">,
  data: unknown,
): Verdict<ValueValidationCode> => {
  if (definition.valueType === "json") return accepted;
  if (typeof data !== "string") return refused("type_mismatch");
  if (definition.valueType === "string") return accepted;
  const option = definition.options?.find((candidate) => candidate.key === data);
  if (!option) return refused("unknown_option");
  return option.archived ? refused("archived_option") : accepted;
};

export type OptionsValidationCode =
  | "options_required"
  | "options_not_allowed"
  | "too_many_options"
  | "invalid_option_key"
  | "duplicate_option_key"
  | "invalid_option_label"
  | "option_description_too_long"
  | "option_removed";

/** The slot-key pattern: an option key is an identifier, never matched against visitor text. */
const optionKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const limits = CONTEXT_VARIABLES_BEHAVIOR.enumOptions;

const optionFault = (option: ContextVariableOption): OptionsValidationCode | null => {
  if (option.key.length > limits.maxKeyChars || !optionKeyPattern.test(option.key)) return "invalid_option_key";
  const label = option.label.trim();
  if (label.length === 0 || label.length > limits.maxLabelChars) return "invalid_option_label";
  if ((option.description?.length ?? 0) > limits.maxDescriptionChars) return "option_description_too_long";
  return null;
};

/**
 * Whether a definition's options fit its type. `previous` is the stored list when an existing
 * definition is edited: every key it holds must still be there, archived or not, because stored
 * values and filters name options by key.
 */
export const validateOptions = (
  valueType: ContextVariableValueType,
  options: readonly ContextVariableOption[] | null,
  previous: readonly ContextVariableOption[] | null,
): Verdict<OptionsValidationCode> => {
  if (valueType !== "enum") return options === null ? accepted : refused("options_not_allowed");
  if (!options || options.length === 0) return refused("options_required");
  if (options.length > limits.maxOptions) return refused("too_many_options");
  const keys = new Set<string>();
  for (const option of options) {
    const fault = optionFault(option);
    if (fault) return refused(fault);
    if (keys.has(option.key)) return refused("duplicate_option_key");
    keys.add(option.key);
  }
  return (previous ?? []).every((option) => keys.has(option.key)) ? accepted : refused("option_removed");
};
