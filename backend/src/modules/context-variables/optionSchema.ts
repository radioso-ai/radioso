import { z } from "zod";

import { CONTEXT_VARIABLES_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";
import type { ContextVariableOption } from "./domain.js";

const limits = CONTEXT_VARIABLES_BEHAVIOR.enumOptions;

/** An option key: the identifier a value stores, never matched against visitor text. */
export const CONTEXT_VARIABLE_OPTION_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const optionFields = {
  key: z.string().max(limits.maxKeyChars).regex(CONTEXT_VARIABLE_OPTION_KEY_PATTERN),
  label: z.string().min(1).max(limits.maxLabelChars).refine((label) => label.trim().length > 0, "A label needs a visible character"),
  description: z.string().max(limits.maxDescriptionChars).nullable(),
  archived: z.boolean(),
};

/**
 * One option of an enum variable as stored and read. The HTTP API, Ray and the module's own
 * definition check all take an option's rules from here.
 */
export const contextVariableOptionSchema = z.object(optionFields);

/** One option as a writer sends it: the description and the archived flag may be left out. */
export const contextVariableOptionInputSchema = z.strictObject({
  ...optionFields,
  description: optionFields.description.optional(),
  archived: optionFields.archived.optional(),
});

/** A written option as it is stored: no description reads as none, and an option is active unless archived. */
export const normalizeContextVariableOption = (
  option: z.infer<typeof contextVariableOptionInputSchema>,
): ContextVariableOption => ({
  key: option.key,
  label: option.label,
  description: option.description ?? null,
  archived: option.archived ?? false,
});
