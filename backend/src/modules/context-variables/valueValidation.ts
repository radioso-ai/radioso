import { isIsoCalendarDate } from "@radioso/conversation-contract";

import { CONTEXT_VARIABLES_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";
import type { ContextVariable, ContextVariableOption, ContextVariableValueType } from "./domain.js";
import { contextVariableOptionSchema } from "./optionSchema.js";

type Verdict<Code extends string> = { ok: true } | { ok: false; code: Code };

export type ValueValidationCode = "type_mismatch" | "unknown_option" | "archived_option";

/** What a value of each type is, as a refusal tells a caller who sent something else. */
export const VALUE_TYPE_EXPECTATIONS: Readonly<Record<ContextVariableValueType, string>> = {
  string: "a string",
  json: "any JSON value",
  enum: "the key of an active option",
  boolean: "true or false, as a JSON boolean",
  number: "a finite JSON number",
  date: "an ISO calendar date such as 2026-11-24",
};

const accepted = { ok: true } as const;
const refused = <Code extends string>(code: Code): Verdict<Code> => ({ ok: false, code });

const fits = (fit: boolean): Verdict<ValueValidationCode> => (fit ? accepted : refused("type_mismatch"));

const validateOption = (options: readonly ContextVariableOption[] | null, data: unknown): Verdict<ValueValidationCode> => {
  if (typeof data !== "string") return refused("type_mismatch");
  const option = options?.find((candidate) => candidate.key === data);
  if (!option) return refused("unknown_option");
  return option.archived ? refused("archived_option") : accepted;
};

/**
 * Whether `data` may be written as the value of a variable. Every writer goes through it. An enum
 * value is the key of an active option; an archived key stays valid where it is already stored, so a
 * reader of stored values treats `archived_option` as readable. A boolean, number or date is the JSON
 * value itself, never text that reads like one: `"true"` is not a boolean, and a date is a calendar
 * day with no time.
 */
export const validateValue = (
  definition: Pick<ContextVariable, "valueType" | "options">,
  data: unknown,
): Verdict<ValueValidationCode> => {
  switch (definition.valueType) {
    case "json":
      return accepted;
    case "string":
      return fits(typeof data === "string");
    case "boolean":
      return fits(typeof data === "boolean");
    case "number":
      return fits(typeof data === "number" && Number.isFinite(data));
    case "date":
      return fits(typeof data === "string" && isIsoCalendarDate(data));
    case "enum":
      return validateOption(definition.options, data);
  }
};

export type OptionsValidationCode =
  | "options_required"
  | "options_not_allowed"
  | "too_many_options"
  | "invalid_option_key"
  | "duplicate_option_key"
  | "invalid_option_label"
  | "option_description_too_long"
  | "option_removed"
  | "active_option_required";

const limits = CONTEXT_VARIABLES_BEHAVIOR.enumOptions;

/** The first field of an option that breaks the option schema, as its code. */
const optionFault = (option: ContextVariableOption): OptionsValidationCode | null => {
  const parsed = contextVariableOptionSchema.safeParse(option);
  if (parsed.success) return null;
  const field = parsed.error.issues[0]?.path[0];
  if (field === "key") return "invalid_option_key";
  return field === "description" ? "option_description_too_long" : "invalid_option_label";
};

/**
 * Whether `next` still holds every key of `previous`, archived or not: stored values and filters
 * name options by key, so an option is archived, never removed.
 */
export const keepsEveryOptionKey = (
  previous: readonly ContextVariableOption[] | null,
  next: readonly ContextVariableOption[] | null,
): boolean => {
  const keys = new Set((next ?? []).map((option) => option.key));
  return (previous ?? []).every((option) => keys.has(option.key));
};

/**
 * Whether a definition's options fit its type. `previous` is the stored list when an existing
 * definition is edited: every key it holds must still be there, archived or not, because stored
 * values and filters name options by key. At least one option stays active, so a value can still
 * be written.
 */
export const validateOptions = (
  valueType: ContextVariableValueType,
  options: readonly ContextVariableOption[] | null,
  previous: readonly ContextVariableOption[] | null,
): Verdict<OptionsValidationCode> => {
  if (valueType !== "enum") return options === null ? accepted : refused("options_not_allowed");
  if (!options || options.length === 0) return refused("options_required");
  if (options.length > limits.maxOptions) return refused("too_many_options");
  // Keys are compared without case: `billing` and `Billing` would read as one option to a person,
  // and since a key never changes or goes away, a pair let in once would stay for good.
  const keys = new Set<string>();
  for (const option of options) {
    const fault = optionFault(option);
    if (fault) return refused(fault);
    const folded = option.key.toLowerCase();
    if (keys.has(folded)) return refused("duplicate_option_key");
    keys.add(folded);
  }
  if (!keepsEveryOptionKey(previous, options)) return refused("option_removed");
  return options.some((option) => !option.archived) ? accepted : refused("active_option_required");
};
