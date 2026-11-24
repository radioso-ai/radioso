// The typed contract a skill declares for the data it returns, and how the model reads it.

/** The value types a declared skill input or output carries: the routine slot types without `item`. */
export type SkillDataValueType = "text" | "number" | "boolean" | "date" | "email";

/** What a list output's field is on a card built from the list. */
export type SkillOutputFieldRole = "key" | "title" | "subtitle" | "image" | "link";

export interface SkillOutputFieldContract {
  type: SkillDataValueType;
  description?: string;
  role?: SkillOutputFieldRole;
}

export type SkillOutputContractEntry =
  | { type: SkillDataValueType; description?: string }
  | { type: "list"; description?: string; fields: Record<string, SkillOutputFieldContract> };

/** Each declared output by name: its type, what it means, and for a list, its fields. */
export type SkillOutputContract = Record<string, SkillOutputContractEntry>;

/**
 * A skill's outputs as typed, described lines for a model to read, one per declared output
 * (`status — Order status (text): "shipped"`), a list as numbered items. A declared output the
 * skill did not return reads as not returned; an output the contract does not declare follows as
 * `name: value`. Values are JSON-encoded, so text a skill returned never breaks the line.
 */
export declare function renderSkillOutputLines(
  outputs: Readonly<Record<string, unknown>>,
  contract: SkillOutputContract,
): string[];
