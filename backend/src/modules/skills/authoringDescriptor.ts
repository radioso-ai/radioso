/**
 * Normalized, kind-agnostic projection of a skill's inputs and outputs for the
 * routine authoring layer (spec 090, US1). The routine editor and validator
 * consume this descriptor; they never read provider-specific skill internals.
 *
 * Source of truth is the existing skills catalog (spec 059): a catalog entry
 * already declares typed `intake.fields` and structured `outcomes`. This module
 * is a pure projection over that shape — no persistence, no provider knowledge.
 */
import type {
  AgentSkillKind,
  AgentSkillSpine,
} from "../agentSkills/domain.js";
import type {
  SkillCapabilityDescriptor,
} from "./capabilityRegistry.js";
import type {
  SkillCatalogEntry,
  SkillIntakeField,
  SkillOutcomeDefinition,
  SkillOutcomeStatus,
} from "./domain.js";
import type { RoutineSkillCategory } from "./routineAuthoringPolicy.js";
import { routineSkillCategoryForBuiltIn } from "./routineAuthoringPolicy.js";

/**
 * Input type vocabulary shown to the author. It preserves the richer skill
 * intake vocabulary (`phone`, `enum`) because that is useful when authoring;
 * mapping onto the narrower routine variable vocabulary
 * (`text|number|boolean|email|date`) for type-compatibility is a validation-time
 * concern, deliberately not baked into the descriptor. `boolean` is carried for
 * alignment with routine variables even though no intake field produces it.
 */
export type SkillAuthoringInputType =
  | "text"
  | "number"
  | "boolean"
  | "email"
  | "date"
  | "phone"
  | "enum";

export interface SkillAuthoringInput {
  key: string;
  type: SkillAuthoringInputType;
  required: boolean;
  description?: string;
  /** Present only for `enum` inputs. */
  enumValues?: string[];
}

export interface SkillAuthoringOutcome {
  name: string;
  displayName: string;
  description?: string;
  status: SkillOutcomeStatus;
}

export interface SkillAuthoringDescriptor {
  skillName: string;
  displayName: string;
  category: RoutineSkillCategory;
  description?: string;
  inputs: SkillAuthoringInput[];
  /**
   * The outcome set — always present. Drives routine branch / field-guard
   * routing even for skills that expose no typed data output schema.
   */
  outcomes: SkillAuthoringOutcome[];
  /**
   * Whether the skill exposes typed data output *fields* (only when it declares
   * an output schema). Catalog entries expose outcomes, not a data schema, so
   * this is always false here; external/MCP skills are handled in a later slice.
   */
  hasDataOutputs: boolean;
}

/** The narrow slice of a catalog entry this projection needs. */
export type SkillCatalogDescriptorSource = Pick<
  SkillCatalogEntry,
  "name" | "displayName" | "description" | "owner" | "intake" | "outcomes"
>;

export interface ExternalSkillAuthoringDescriptorSource {
  skillName: string;
  displayName?: string;
  description?: string;
  exposedParams: Record<string, { description?: string }>;
  declaredOutcomes?: string[] | null;
  outcomeMap?: Record<string, string> | null;
}

const validOutcomeStatuses = new Set<SkillOutcomeStatus>([
  "active",
  "paused",
  "awaiting_confirmation",
  "awaiting_tool",
  "completed",
  "cancelled",
  "expired",
  "failed",
]);

const mapInputType = (type: SkillIntakeField["type"]): SkillAuthoringInputType =>
  type === "string" ? "text" : type;

const toAuthoringInput = (field: SkillIntakeField): SkillAuthoringInput => ({
  key: field.name,
  type: mapInputType(field.type),
  required: field.required,
  ...(field.extractionHint ? { description: field.extractionHint } : {}),
  ...(field.type === "enum" && field.enumValues ? { enumValues: field.enumValues } : {}),
});

const toAuthoringOutcome = (outcome: SkillOutcomeDefinition): SkillAuthoringOutcome => ({
  name: outcome.name,
  displayName: outcome.displayName,
  status: outcome.status,
  ...(outcome.description ? { description: outcome.description } : {}),
});

/**
 * Project a skills-catalog entry (built-in skills, customer-email, retrieval)
 * into the normalized authoring descriptor.
 */
export const skillCatalogEntryToAuthoringDescriptor = (
  entry: SkillCatalogDescriptorSource,
): SkillAuthoringDescriptor => ({
  skillName: entry.name,
  displayName: entry.displayName,
  category: routineSkillCategoryForBuiltIn(entry),
  ...(entry.description ? { description: entry.description } : {}),
  inputs: (entry.intake?.fields ?? []).map(toAuthoringInput),
  outcomes: (entry.outcomes ?? []).map(toAuthoringOutcome),
  hasDataOutputs: false,
});

const statusForExternalOutcome = (name: string): SkillOutcomeStatus => {
  if (validOutcomeStatuses.has(name as SkillOutcomeStatus)) {
    return name as SkillOutcomeStatus;
  }
  // External outcomeMap maps tool result names to outcome names, not statuses.
  // When an outcome name is not itself a valid SkillOutcomeStatus, there is no
  // persisted status metadata to preserve, so authoring gets the neutral success
  // default and runtime can still route by the outcome name.
  return "completed";
};

const toExternalOutcome = (name: string): SkillAuthoringOutcome => ({
  name,
  displayName: name,
  status: statusForExternalOutcome(name),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalDescription = (value: unknown): string | undefined =>
  isRecord(value) && typeof value.description === "string" && value.description.trim().length > 0
    ? value.description
    : undefined;

const exposedRequired = (value: unknown, fallback: boolean): boolean =>
  isRecord(value) && typeof value.required === "boolean" ? value.required : fallback;

const humanizeIdentifier = (value: string): string =>
  value
    .replace(/[._-]+/gu, " ")
    .trim()
    .replace(/\b\w/gu, (character) => character.toUpperCase());

const agentSkillCategory = (kind: AgentSkillKind): RoutineSkillCategory => {
  if (kind === "retrieve") {
    return "retrieval";
  }
  return kind;
};

const inputTypeForKey = (key: string): SkillAuthoringInputType =>
  key === "email" || key === "to" || key === "cc" || key === "replyTo" ? "email" : "text";

const staticInputSchemaRecord = (descriptor: SkillCapabilityDescriptor): Record<string, unknown> =>
  descriptor.inputSchema.source === "static" && isRecord(descriptor.inputSchema.schema)
    ? descriptor.inputSchema.schema
    : {};

const staticFieldsForCapability = (descriptor: SkillCapabilityDescriptor): string[] => {
  const schema = staticInputSchemaRecord(descriptor);
  return Array.isArray(schema.fields) ? schema.fields.filter((field): field is string => typeof field === "string") : [];
};

const staticRequiredForCapability = (descriptor: SkillCapabilityDescriptor): Set<string> => {
  const schema = staticInputSchemaRecord(descriptor);
  return new Set(Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === "string") : []);
};

const exposedInputsForAgentSkill = (config: Record<string, unknown>): Record<string, unknown> | null => {
  if (isRecord(config.exposedPayload)) {
    return config.exposedPayload;
  }
  if (isRecord(config.exposedInputs)) {
    return config.exposedInputs;
  }
  return null;
};

const inputsForAgentSkill = (
  source: AgentSkillSpine,
  descriptor: SkillCapabilityDescriptor,
): SkillAuthoringInput[] => {
  const parsedConfig = descriptor.validateConfig(source.config ?? {});
  const config = isRecord(parsedConfig.data) ? parsedConfig.data : source.config ?? {};
  const exposedInputs = exposedInputsForAgentSkill(config);
  const fieldNames = exposedInputs
    ? Object.entries(exposedInputs)
      .filter(([, spec]) => spec !== false)
      .map(([key]) => key)
    : staticFieldsForCapability(descriptor);
  const requiredFields = staticRequiredForCapability(descriptor);

  return fieldNames.map((key) => {
    const spec = exposedInputs?.[key];
    return {
      key,
      type: inputTypeForKey(key),
      required: exposedRequired(spec, requiredFields.has(key)),
      ...(optionalDescription(spec) ? { description: optionalDescription(spec) } : {}),
    };
  });
};

/**
 * Project an external/MCP skill definition into the normalized authoring
 * descriptor. External definitions store only the exposed-input allow-list and
 * optional outcome names; bound params are author-fixed and intentionally absent
 * from this source shape.
 */
export const externalSkillToAuthoringDescriptor = (
  source: ExternalSkillAuthoringDescriptorSource,
): SkillAuthoringDescriptor => {
  const outcomeNames = [
    ...(source.declaredOutcomes ?? []),
    ...Object.values(source.outcomeMap ?? {}),
  ];
  const uniqueOutcomeNames = [...new Set(outcomeNames)];
  const outcomes = uniqueOutcomeNames.length > 0
    ? uniqueOutcomeNames.map(toExternalOutcome)
    : ["completed", "failed"].map(toExternalOutcome);

  return {
    skillName: source.skillName,
    displayName: source.displayName ?? source.skillName,
    category: "external_mcp",
    ...(source.description ? { description: source.description } : {}),
    inputs: Object.entries(source.exposedParams).map(([key, spec]) => ({
      key,
      type: "text",
      // External skill definitions do not retain the MCP tool input JSON schema,
      // so the descriptor cannot know which exposed params were required.
      required: false,
      ...(spec.description ? { description: spec.description } : {}),
    })),
    outcomes,
    hasDataOutputs: false,
  };
};

export const agentSkillToAuthoringDescriptor = (
  source: AgentSkillSpine,
  descriptor: SkillCapabilityDescriptor,
): SkillAuthoringDescriptor => ({
  skillName: source.skillName,
  displayName: humanizeIdentifier(source.skillName),
  category: agentSkillCategory(source.kind),
  inputs: inputsForAgentSkill(source, descriptor),
  outcomes: descriptor.outcomeVocabulary.map(toExternalOutcome),
  hasDataOutputs: false,
});
