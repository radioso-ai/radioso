import {
  MAX_CONFIGURATION_ENTRIES,
  MAX_CONFIGURATION_VALUE_LENGTH,
  type ConfigurationField,
  type ConfigurationValues,
} from "./configuration.js";
import type { Contribution } from "./contributions.js";
import type { Destination } from "./destinations.js";
import { fieldKeySchema, type ConnectionSlotId, type ContributionId } from "./identifiers.js";
import type { AppManifest } from "./manifest.js";
import type { ManifestValidationIssue } from "./validate.js";

/**
 * What one installation has to supply before it can run, and what it turns on
 * once it has. Both answers are pure functions of a validated manifest and the
 * operator's stored values, so the dashboard, the installation plan, and the
 * gateway reach the same conclusion from the same declaration rather than each
 * inventing a resolution rule.
 */
export type ConfigurationResolutionResult =
  | { ok: true; configuration: ConfigurationValues }
  | { ok: false; issues: ManifestValidationIssue[] };

/**
 * A caller that walks the list gets a bounded one. A stored map with thousands
 * of unknown keys is a defect or an attack, and either way the answer is the
 * same sentence repeated, so the list stops long before it becomes the payload.
 */
const MAX_CONFIGURATION_ISSUES = 32;

type ValueField = Exclude<ConfigurationField, { type: "connection_slot" }>;

const issue = (code: string, path: string, message: string): ManifestValidationIssue => ({
  code,
  path,
  message,
});

/**
 * A path names the key only when the key is one the manifest's own rule would
 * admit. An attacker-chosen key can be four kilobytes of anything, and a
 * diagnostic that echoes it lands in an audit record and an operator's screen,
 * so an unrecognisable key is addressed by position instead.
 */
const pathFor = (key: string, position: number): string =>
  fieldKeySchema.safeParse(key).success ? key : `configuration.${position}`;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

const parsedUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * Shape, key, and value-size bounds, applied before any field is looked up.
 * Doing it the other way round means a huge map buys a per-key diagnostic and a
 * full traversal on its way to being refused.
 */
const boundsIssues = (supplied: Record<string, unknown>): ManifestValidationIssue[] => {
  const issues: ManifestValidationIssue[] = [];
  let position = 0;
  for (const key in supplied) {
    if (!Object.hasOwn(supplied, key)) continue;
    if (position >= MAX_CONFIGURATION_ENTRIES) {
      issues.push(
        issue(
          "too_many_configuration_entries",
          "configuration",
          `Configuration holds at most ${MAX_CONFIGURATION_ENTRIES} entries`,
        ),
      );
      return issues;
    }
    const path = pathFor(key, position);
    const value = supplied[key];
    if (path !== key) {
      issues.push(
        issue("invalid_configuration_key", path, "A configuration key is lower-case snake case, 1 to 64 characters"),
      );
    } else if (typeof value === "string" && value.length > MAX_CONFIGURATION_VALUE_LENGTH) {
      issues.push(
        issue("value_too_long", path, `A value holds at most ${MAX_CONFIGURATION_VALUE_LENGTH} characters`),
      );
    }
    position += 1;
    if (issues.length >= MAX_CONFIGURATION_ISSUES) return issues;
  }
  return issues;
};

/**
 * A URL field that a destination's host is built from carries more than a URL:
 * it decides the scheme the broker speaks and, through userinfo, could hand the
 * App's own requests a credential the manifest never declared. Neither belongs
 * in a value space the operator can type into freely.
 */
const urlDestinationIssues = (
  field: ValueField,
  value: string,
  destinations: readonly Destination[],
): ManifestValidationIssue[] => {
  if (field.type !== "url" || destinations.length === 0) return [];
  const url = parsedUrl(value);
  if (!url) return [];
  const issues: ManifestValidationIssue[] = [];
  if (url.username !== "" || url.password !== "") {
    issues.push(
      issue(
        "url_carries_userinfo",
        field.key,
        "A destination address holds no user name or password; credentials belong in a connection slot",
      ),
    );
  }
  const scheme = url.protocol.replace(":", "");
  for (const destination of destinations) {
    if (destination.protocols.some((protocol) => protocol === scheme)) continue;
    issues.push(
      issue(
        "url_protocol_not_declared",
        field.key,
        `Destination ${destination.id} reaches ${destination.protocols.join(" and ")} addresses only`,
      ),
    );
  }
  return issues;
};

const checkValue = (
  field: ValueField,
  value: unknown,
  destinations: readonly Destination[],
): ManifestValidationIssue[] => {
  const key = field.key;
  const wrongType = (expected: string): ManifestValidationIssue[] => [
    issue("invalid_value_type", key, `This field takes ${expected}`),
  ];

  switch (field.type) {
    case "text":
    case "url":
    case "select": {
      if (typeof value !== "string") return wrongType("a string");
      if (value.length > MAX_CONFIGURATION_VALUE_LENGTH) {
        return [
          issue("value_too_long", key, `A value holds at most ${MAX_CONFIGURATION_VALUE_LENGTH} characters`),
        ];
      }
      if (field.type === "url" && parsedUrl(value) === null) {
        return [issue("invalid_url_value", key, "This field takes a URL")];
      }
      if (field.type === "select" && !field.options.some((option) => option.value === value)) {
        return [issue("unknown_select_option", key, "This field declares no such option")];
      }
      return urlDestinationIssues(field, value, destinations);
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return wrongType("a finite number");
      if (field.min !== undefined && value < field.min) {
        return [issue("value_out_of_range", key, `This field starts at ${field.min}`)];
      }
      if (field.max !== undefined && value > field.max) {
        return [issue("value_out_of_range", key, `This field stops at ${field.max}`)];
      }
      return [];
    }
    case "boolean": {
      return typeof value === "boolean" ? [] : wrongType("a boolean");
    }
  }
};

const destinationsByHostField = (manifest: AppManifest): ReadonlyMap<string, Destination[]> => {
  const bound = new Map<string, Destination[]>();
  for (const destination of manifest.destinations) {
    if (destination.host.kind !== "configuration") continue;
    const existing = bound.get(destination.host.field);
    if (existing) existing.push(destination);
    else bound.set(destination.host.field, [destination]);
  }
  return bound;
};

/**
 * Turns what the host stored into what an App reads. The order is fixed and it
 * matters: bound the input, copy it, materialize the manifest's defaults, then
 * validate the map that results. Validating the stored map instead would call a
 * required field with a default missing, and would hand the invocation a sparse
 * object in which a handler cannot tell an unset value from a defaulted one.
 *
 * The result on success is the effective configuration — every declared field an
 * installation has a value for, and nothing else. `context.configuration` on an
 * invocation is exactly this map. Nothing in it is credential material: no
 * configuration field type holds a secret, and a `connection_slot` field holds
 * its value in the slot.
 */
export const resolveConfiguration = (
  manifest: AppManifest,
  storedValues: unknown,
): ConfigurationResolutionResult => {
  if (!isPlainObject(storedValues)) {
    return {
      ok: false,
      issues: [issue("invalid_configuration_values", "configuration", "Configuration is a JSON object")],
    };
  }

  const bounds = boundsIssues(storedValues);
  if (bounds.length > 0) return { ok: false, issues: bounds };

  const declared = new Map(manifest.configuration.fields.map((field) => [field.key, field]));
  const bound = destinationsByHostField(manifest);
  const effective: Record<string, unknown> = {};
  const issues: ManifestValidationIssue[] = [];

  let position = 0;
  for (const key in storedValues) {
    if (!Object.hasOwn(storedValues, key)) continue;
    const path = pathFor(key, position);
    position += 1;
    const field = declared.get(key);
    if (!field) {
      issues.push(issue("unknown_configuration_key", path, "The manifest declares no such configuration field"));
      continue;
    }
    if (field.type === "connection_slot") {
      issues.push(
        issue(
          "connection_slot_has_no_value",
          path,
          "This field binds a connection slot, whose value lives in the slot",
        ),
      );
      continue;
    }
    effective[key] = storedValues[key];
  }

  for (const field of manifest.configuration.fields) {
    if (field.type === "connection_slot") continue;
    if (Object.hasOwn(effective, field.key)) continue;
    if (field.default !== undefined) {
      effective[field.key] = field.default;
      continue;
    }
    if (!field.required) continue;
    issues.push(issue("missing_required_value", field.key, "This field is required"));
  }

  for (const field of manifest.configuration.fields) {
    if (issues.length >= MAX_CONFIGURATION_ISSUES) break;
    if (field.type === "connection_slot") continue;
    if (!Object.hasOwn(effective, field.key)) continue;
    issues.push(...checkValue(field, effective[field.key], bound.get(field.key) ?? []));
  }

  if (issues.length === 0) return { ok: true, configuration: effective as ConfigurationValues };
  return { ok: false, issues: issues.slice(0, MAX_CONFIGURATION_ISSUES) };
};

/**
 * Which contributions an installation runs, and therefore which connection slots
 * the operator has to bind. Both follow from the manifest and the effective
 * configuration, never from a list a caller passes in: a caller-supplied subset
 * can omit a `required` contribution, and an installation that omits one is not
 * the App the operator agreed to install.
 */
export interface InstallationReadiness {
  activeContributionIds: ContributionId[];
  inactiveContributionIds: ContributionId[];
  requiredConnectionSlots: ConnectionSlotId[];
}

/**
 * A `required` contribution is active by definition. The one thing that turns a
 * contribution off is a schedule the operator disabled: an
 * `interval_from_configuration` task whose field holds the schedule's own
 * `disabledValue` never runs, so the slots it names are slots nobody has to
 * fill in.
 */
const isActive = (contribution: Contribution, configuration: ConfigurationValues): boolean => {
  if (contribution.availability === "required") return true;
  if (contribution.kind !== "scheduled_task") return true;
  const schedule = contribution.schedule;
  if (schedule.kind !== "interval_from_configuration") return true;
  if (schedule.disabledValue === undefined) return true;
  return configuration[schedule.field] !== schedule.disabledValue;
};

export const installationReadiness = (
  manifest: AppManifest,
  effectiveConfiguration: ConfigurationValues,
): InstallationReadiness => {
  const activeContributionIds: ContributionId[] = [];
  const inactiveContributionIds: ContributionId[] = [];
  const slots = new Set<ConnectionSlotId>();

  for (const contribution of manifest.contributions) {
    if (!isActive(contribution, effectiveConfiguration)) {
      inactiveContributionIds.push(contribution.id);
      continue;
    }
    activeContributionIds.push(contribution.id);
    for (const slot of contribution.requiredConnectionSlots) slots.add(slot);
  }

  return {
    activeContributionIds,
    inactiveContributionIds,
    requiredConnectionSlots: [...slots].sort(),
  };
};
