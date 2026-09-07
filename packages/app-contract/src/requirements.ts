import {
  MAX_CONFIGURATION_VALUE_LENGTH,
  type ConfigurationField,
  type ConfigurationValues,
} from "./configuration.js";
import type { ConnectionSlotId } from "./identifiers.js";
import type { AppManifest } from "./manifest.js";
import type { ManifestValidationIssue } from "./validate.js";

/**
 * What one installation has to supply before it can run, derived from the
 * manifest rather than from any App's own conventions. Both answers are pure
 * functions of a validated manifest, so the dashboard, the installation plan,
 * and the gateway reach the same conclusion from the same declaration.
 */
export type ConfigurationValuesResult =
  | { ok: true; values: ConfigurationValues }
  | { ok: false; issues: ManifestValidationIssue[] };

const issue = (code: string, path: string, message: string): ManifestValidationIssue => ({
  code,
  path,
  message,
});

const isUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const checkValue = (
  field: Exclude<ConfigurationField, { type: "connection_slot" }>,
  value: unknown,
): ManifestValidationIssue[] => {
  const key = field.key;
  const wrongType = (expected: string): ManifestValidationIssue[] => [
    issue("invalid_value_type", key, `Field ${key} takes ${expected}`),
  ];

  switch (field.type) {
    case "text":
    case "url":
    case "select": {
      if (typeof value !== "string") return wrongType("a string");
      if (value.length > MAX_CONFIGURATION_VALUE_LENGTH) {
        return [
          issue(
            "value_too_long",
            key,
            `Field ${key} holds at most ${MAX_CONFIGURATION_VALUE_LENGTH} characters`,
          ),
        ];
      }
      if (field.type === "url" && !isUrl(value)) {
        return [issue("invalid_url_value", key, `Field ${key} takes a URL`)];
      }
      if (field.type === "select" && !field.options.some((option) => option.value === value)) {
        return [issue("unknown_select_option", key, `Field ${key} has no option ${value}`)];
      }
      return [];
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return wrongType("a finite number");
      if (field.min !== undefined && value < field.min) {
        return [issue("value_out_of_range", key, `Field ${key} starts at ${field.min}`)];
      }
      if (field.max !== undefined && value > field.max) {
        return [issue("value_out_of_range", key, `Field ${key} stops at ${field.max}`)];
      }
      return [];
    }
    case "boolean": {
      return typeof value === "boolean" ? [] : wrongType("a boolean");
    }
  }
};

/**
 * Measures an installation's configuration against the manifest that declares
 * it. The gateway builds an invocation's `context` from the result, so an App
 * reads values that are present, typed, in range, and declared — and never
 * reads a credential, because a `connection_slot` field holds no value here.
 */
export const validateConfigurationValues = (
  manifest: AppManifest,
  values: unknown,
): ConfigurationValuesResult => {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return {
      ok: false,
      issues: [issue("invalid_configuration_values", "", "Configuration values must be an object")],
    };
  }

  const supplied = values as Record<string, unknown>;
  const declared = new Map(manifest.configuration.fields.map((field) => [field.key, field]));
  const issues: ManifestValidationIssue[] = [];

  for (const key of Object.keys(supplied)) {
    const field = declared.get(key);
    if (!field) {
      issues.push(issue("unknown_configuration_key", key, `No configuration field ${key} is declared`));
      continue;
    }
    if (field.type === "connection_slot") {
      issues.push(
        issue(
          "connection_slot_has_no_value",
          key,
          `Field ${key} binds connection slot ${field.connectionSlot}, whose value lives in the slot`,
        ),
      );
      continue;
    }
    issues.push(...checkValue(field, supplied[key]));
  }

  for (const field of manifest.configuration.fields) {
    if (field.type === "connection_slot" || !field.required) continue;
    if (Object.hasOwn(supplied, field.key)) continue;
    issues.push(issue("missing_required_value", field.key, `Field ${field.key} is required`));
  }

  return issues.length === 0 ? { ok: true, values: supplied as ConfigurationValues } : { ok: false, issues };
};

/**
 * The connection slots an installation must bind, given the contributions it
 * turns on. A slot named by no active contribution is one the operator never
 * has to fill in, which is what lets a push-only installation exist beside a
 * polling one under the same release.
 */
export const requiredConnectionSlotsFor = (
  manifest: AppManifest,
  activeContributionIds: readonly string[],
): ConnectionSlotId[] => {
  const active = new Set(activeContributionIds);
  const required: ConnectionSlotId[] = [];
  for (const contribution of manifest.contributions) {
    if (!active.has(contribution.id)) continue;
    for (const slot of contribution.requiredConnectionSlots) {
      if (!required.includes(slot)) required.push(slot);
    }
  }
  return required;
};
