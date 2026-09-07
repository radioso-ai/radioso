import { readBoundedMap } from "./bounds.js";
import {
  MAX_CONFIGURATION_ENTRIES,
  MAX_CONFIGURATION_VALUE_LENGTH,
  type ConfigurationField,
  type ConfigurationValues,
} from "./configuration.js";
import { satisfiesSchedule, type ConfigurationSchedule, type Contribution } from "./contributions.js";
import {
  checkDestinationBoundUrl,
  destinationUrlRejectionMessage,
  destinationsByHostField,
  type Destination,
} from "./destinations.js";
import { fieldKeySchema, type ConnectionSlotId, type ContributionId } from "./identifiers.js";
import type { AppManifest } from "./manifest.js";
import type { AdmittedManifest, ManifestValidationIssue } from "./validate.js";

/**
 * What one installation has to supply before it can run, and what it turns on
 * once it has. Both answers are pure functions of a validated manifest and the
 * operator's stored values, so the dashboard, the installation plan, and the
 * gateway reach the same conclusion from the same declaration rather than each
 * inventing a resolution rule.
 */

declare const effectiveConfigurationBrand: unique symbol;

/**
 * A configuration that resolution produced: defaults materialized, every value
 * checked against the field that declares it. The brand is a symbol this module
 * does not export, so nothing outside it can write the type down, and the map
 * itself is frozen — the two together are what keep a caller from handing
 * readiness a stored map with a required field missing, or from editing an
 * interval out of a resolved one, and reading the answer as authoritative.
 */
export type EffectiveConfiguration = Readonly<ConfigurationValues> & {
  readonly [effectiveConfigurationBrand]: true;
};

type ConfigurationResolutionResult =
  | { ok: true; configuration: EffectiveConfiguration }
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
 * A path names the key only when the manifest declares it. An attacker-chosen
 * key can be four kilobytes of anything and can be spelled exactly like a
 * field key — `customer_ssn_123456789` satisfies every rule the shape has — and
 * a diagnostic that echoes it lands in an audit record and on an operator's
 * screen. So only a declared key is ever repeated; everything else is addressed
 * by its position in the stored map.
 */
const pathFor = (key: string, position: number, declared: ReadonlyMap<string, ConfigurationField>): string =>
  declared.has(key) ? key : `configuration.${position}`;

const parsedUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * Key and value-size bounds, applied before any field is looked up. Doing it the
 * other way round means a huge map buys a per-key diagnostic and a full
 * traversal on its way to being refused.
 */
const boundsIssues = (
  supplied: Record<string, unknown>,
  declared: ReadonlyMap<string, ConfigurationField>,
): ManifestValidationIssue[] => {
  const issues: ManifestValidationIssue[] = [];
  let position = 0;
  for (const key in supplied) {
    const path = pathFor(key, position, declared);
    const value = supplied[key];
    if (!fieldKeySchema.safeParse(key).success) {
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
 * A stored URL is held to the destinations built from it by the same check
 * admission applies to that field's declared default, so a value an author
 * shipped and a value an operator typed are refused on the same grounds.
 */
const urlDestinationIssues = (
  field: ValueField,
  value: string,
  destinations: readonly Destination[],
): ManifestValidationIssue[] =>
  field.type === "url"
    ? checkDestinationBoundUrl(value, destinations).map((rejection) =>
        issue(rejection.reason, field.key, destinationUrlRejectionMessage(rejection)),
      )
    : [];

/**
 * A schedule-bound number has a value space of its own, and it is not the
 * field's: an interval either disables the task by being exactly the sentinel,
 * or runs it by being a whole number of seconds inside the declared range.
 * Anything else — 30 against a 60 second floor, 1.5, a year — would leave the
 * host to invent a rounding or a clamp, and a task an operator believes is off
 * running every minute is the failure that invention produces.
 */
const scheduleValueIssues = (
  field: ValueField,
  value: number,
  schedules: readonly ConfigurationSchedule[],
): ManifestValidationIssue[] =>
  schedules.flatMap((schedule) => {
    if (satisfiesSchedule(schedule, value)) return [];
    const off =
      schedule.disabledValue === undefined ? "" : `, or ${schedule.disabledValue} to leave it off`;
    return [
      issue(
        "schedule_value_out_of_range",
        field.key,
        `This schedule runs on a whole number of seconds from ${schedule.minSeconds} to ${schedule.maxSeconds}${off}`,
      ),
    ];
  });

const checkValue = (
  field: ValueField,
  value: unknown,
  destinations: readonly Destination[],
  schedules: readonly ConfigurationSchedule[],
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
      return scheduleValueIssues(field, value, schedules);
    }
    case "boolean": {
      return typeof value === "boolean" ? [] : wrongType("a boolean");
    }
  }
};

const schedulesByField = (manifest: AppManifest): ReadonlyMap<string, ConfigurationSchedule[]> => {
  const bound = new Map<string, ConfigurationSchedule[]>();
  for (const contribution of manifest.contributions) {
    if (contribution.kind !== "scheduled_task") continue;
    const schedule = contribution.schedule;
    if (schedule.kind !== "interval_from_configuration") continue;
    const existing = bound.get(schedule.field);
    if (existing) existing.push(schedule);
    else bound.set(schedule.field, [schedule]);
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
const resolveConfiguration = (
  manifest: AppManifest,
  storedValues: unknown,
): ConfigurationResolutionResult => {
  const read = readBoundedMap(storedValues, MAX_CONFIGURATION_ENTRIES);
  if (!read.ok) {
    return {
      ok: false,
      issues: [
        read.failure === "too_many_entries"
          ? issue(
              "too_many_configuration_entries",
              "configuration",
              `Configuration holds at most ${MAX_CONFIGURATION_ENTRIES} entries`,
            )
          : issue(
              "invalid_configuration_values",
              "configuration",
              "Configuration is a JSON object carrying its own data properties only",
            ),
      ],
    };
  }
  const supplied = read.map;

  const declared = new Map(manifest.configuration.fields.map((field) => [field.key, field]));

  const bounds = boundsIssues(supplied, declared);
  if (bounds.length > 0) return { ok: false, issues: bounds };

  const bound = destinationsByHostField(manifest.destinations);
  const scheduled = schedulesByField(manifest);
  const effective: Record<string, unknown> = {};
  const issues: ManifestValidationIssue[] = [];

  let position = 0;
  for (const key in supplied) {
    const path = pathFor(key, position, declared);
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
    effective[key] = supplied[key];
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
    issues.push(
      ...checkValue(
        field,
        effective[field.key],
        bound.get(field.key) ?? [],
        scheduled.get(field.key) ?? [],
      ),
    );
  }

  if (issues.length === 0) {
    return { ok: true, configuration: Object.freeze(effective) as EffectiveConfiguration };
  }
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
 * A `required` contribution is active by definition, and admission refuses one
 * that declares a `disabledValue`, so the two never contradict each other here.
 * The one thing that turns a contribution off is a schedule the operator
 * disabled: an `interval_from_configuration` task whose field holds the
 * schedule's own `disabledValue` never runs, so the slots it names are slots
 * nobody has to fill in.
 *
 * A schedule-bound field is present in every effective configuration, because
 * `validateManifest` refuses a manifest whose schedule reads a field an
 * installation could leave empty, and `resolveInstallation` only ever runs
 * against a manifest that has passed it. An absent value here would activate a
 * task with no interval to run it on, and a host would have to invent one.
 */
const isActive = (contribution: Contribution, configuration: EffectiveConfiguration): boolean => {
  if (contribution.kind !== "scheduled_task") return true;
  const schedule = contribution.schedule;
  if (schedule.kind !== "interval_from_configuration") return true;
  if (contribution.availability === "required") return true;
  if (schedule.disabledValue === undefined) return true;
  return configuration[schedule.field] !== schedule.disabledValue;
};

const installationReadiness = (
  manifest: AppManifest,
  effectiveConfiguration: EffectiveConfiguration,
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

export type InstallationResolutionResult =
  | { ok: true; configuration: EffectiveConfiguration; readiness: InstallationReadiness }
  | { ok: false; issues: ManifestValidationIssue[] };

/**
 * The one door from a manifest and an operator's stored values to what an
 * installation runs. Resolution and readiness are one call because they are one
 * answer: a caller that could hold them apart could resolve against one manifest
 * and ask readiness about another, and read the mismatch as authoritative. The
 * dashboard, the installation plan, and the gateway all come through here, so
 * all three reach the same conclusion.
 *
 * The parameter is an `AdmittedManifest`, not an ordinary `AppManifest`:
 * admission is `validateManifest`'s job alone, proved once, at the one boundary
 * that owns it. A caller cannot reach this function with a manifest that
 * `validateManifest` would refuse — the type makes that state unrepresentable
 * rather than asking this module to re-derive a partial copy of the same
 * checks. It still never throws: every failure left to find here is in the
 * operator's stored values, not in the manifest.
 */
export const resolveInstallation = (
  manifest: AdmittedManifest,
  storedValues: unknown,
): InstallationResolutionResult => {
  const resolved = resolveConfiguration(manifest, storedValues);
  if (!resolved.ok) return { ok: false, issues: resolved.issues };
  return {
    ok: true,
    configuration: resolved.configuration,
    readiness: installationReadiness(manifest, resolved.configuration),
  };
};
