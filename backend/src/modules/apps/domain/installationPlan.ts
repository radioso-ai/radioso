import {
  executionClassForContributionKind,
  resolveInstallation,
  type AppManifest,
  type ConnectionSlot,
  type EffectiveConfiguration,
  type ExecutionClass,
  type InstallationReadiness,
} from "@radioso/app-contract";

import { canonicalDigest } from "./canonicalJson.js";
import { AppsError } from "./errors.js";

/** How long an approved plan stays applicable before it must be reviewed again. */
export const APP_INSTALLATION_PLAN_TTL_MS = 30 * 60 * 1000;

export const appGrantKinds = ["permission", "destination", "collection", "contribution"] as const;
export type AppGrantKind = (typeof appGrantKinds)[number];

export type AppConfigurationValue = string | number | boolean;

export interface AppPlannedGrant {
  readonly kind: AppGrantKind;
  readonly key: string;
}

/**
 * What the broker would build out of a bound slot when it calls this destination. The
 * mode is on the plan because "we send your WordPress password as HTTP basic auth to
 * example.com" is the thing an operator is actually approving.
 */
interface AppPlannedDestinationCredentials {
  readonly slotId: string;
  readonly mode: string;
  readonly required: boolean;
}

export interface AppPlannedDestination {
  readonly id: string;
  /** Resolved at plan time; `null` when the configuration field it binds is unfilled. */
  readonly host: string | null;
  readonly protocols: readonly string[];
  readonly credentials: AppPlannedDestinationCredentials | null;
}

export interface AppPlannedConnectionSlot {
  readonly slotId: string;
  readonly kind: string;
  readonly required: boolean;
  readonly bound: boolean;
}

export interface AppPlannedContribution {
  readonly id: string;
  readonly kind: string;
  /** `null` for a kind whose execution class only its own release defines. */
  readonly executionClass: ExecutionClass | null;
  readonly availability: string;
  /** False when this configuration turns it off, which is also why its slots go unrequired. */
  readonly active: boolean;
}

export interface AppUnresolvedRequirement {
  readonly code: "configuration_required" | "connection_unbound" | "destination_host_unresolved";
  readonly path: string;
  readonly message: string;
}

/**
 * Everything the approving operator saw, and nothing else. The checksum is taken over
 * this value, so anything that can change what installation does must appear here.
 */
export interface AppInstallationPlan {
  readonly planVersion: 1;
  readonly workspaceId: string;
  readonly releaseId: string;
  readonly appId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly configuration: Readonly<Record<string, AppConfigurationValue>>;
  readonly grants: readonly AppPlannedGrant[];
  readonly destinations: readonly AppPlannedDestination[];
  readonly storageCollections: readonly string[];
  readonly contributions: readonly AppPlannedContribution[];
  readonly connectionSlots: readonly AppPlannedConnectionSlot[];
  readonly targetAgentIds: readonly string[];
  readonly unresolvedRequirements: readonly AppUnresolvedRequirement[];
}

interface AppInstallationPlanRelease {
  readonly id: string;
  readonly appId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly manifest: AppManifest;
}

interface AppInstallationPlanInput {
  readonly workspaceId: string;
  readonly release: AppInstallationPlanRelease;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly boundConnectionSlotIds: readonly string[];
  readonly targetAgentIds: readonly string[];
  readonly now: Date;
}

interface AppInstallationPlanResult {
  readonly plan: AppInstallationPlan;
  readonly checksum: string;
  readonly expiresAt: Date;
}

const invalidConfiguration = (key: string, message: string): AppsError =>
  new AppsError("invalid_configuration", message, { field: key });

interface ResolvedAppConfiguration {
  /**
   * The branded, readiness-safe configuration — present only once every required field
   * has a value. `null` here is not "empty"; it is "not yet an authoritative answer to
   * what this installation does".
   */
  readonly configuration: EffectiveConfiguration | null;
  /**
   * What the operator has entered so far, defaults materialised for every field that
   * resolved. Display-only: the draft plan shows it back so the operator sees what they
   * filled in.
   */
  readonly values: Readonly<Record<string, AppConfigurationValue>>;
  readonly unresolved: AppUnresolvedRequirement[];
  /**
   * `resolveInstallation` hands back readiness together with configuration on success, so
   * this is that same answer, and `UNDETERMINED_READINESS` on a draft that has not
   * resolved yet — never a second, separately computed readiness.
   */
  readonly readiness: InstallationReadiness;
}

/**
 * A configuration still missing a required field has no authoritative answer to "what
 * does this installation do", so readiness is reported as undetermined rather than
 * guessed from the draft: nothing is active and nothing is required yet. The plan's
 * `unresolvedRequirements` list — not this — is what tells the operator the plan is not
 * ready, so the shape here stays identical to a resolved plan's rather than growing a
 * separate "pending" case for callers to branch on.
 */
const UNDETERMINED_READINESS: InstallationReadiness = {
  activeContributionIds: [],
  inactiveContributionIds: [],
  requiredConnectionSlots: [],
};

/**
 * Only declared fields survive, and what survives is measured by the contract package's
 * own resolver rather than by a second copy of its rules here: `resolveInstallation`
 * materialises manifest defaults itself, so this function submits the operator's raw
 * input unchanged and never pre-fills a default before asking. The two outcomes are kept
 * apart on purpose: a value that is wrong is a bad request, while a required value that
 * is simply absent is a hole the plan shows the operator so they can fill it. Resolution
 * and readiness are one call, so a draft plan never asks readiness about a configuration
 * other than the one it just resolved.
 */
const resolveAppConfiguration = (
  manifest: AppManifest,
  submitted: Readonly<Record<string, unknown>>,
): ResolvedAppConfiguration => {
  const declared = new Map(manifest.configuration.fields.map((field) => [field.key, field]));
  const result = resolveInstallation(manifest, submitted);
  if (result.ok) {
    return {
      configuration: result.configuration,
      values: result.configuration,
      unresolved: [],
      readiness: result.readiness,
    };
  }

  const missing = new Set<string>();
  const unresolved: AppUnresolvedRequirement[] = [];
  for (const issue of result.issues) {
    if (issue.code !== "missing_required_value") throw invalidConfiguration(issue.path, issue.message);
    missing.add(issue.path);
    unresolved.push({
      code: "configuration_required",
      path: `configuration.${issue.path}`,
      message: `${declared.get(issue.path)?.label ?? issue.path} has no value yet.`,
    });
  }

  // Every remaining issue is a required field with no default and nothing submitted for
  // it. Every other declared field already passed `resolveInstallation`'s own checks, so
  // the draft plan can still show the operator what they filled in and what the manifest
  // defaults, leaving only the fields nobody has reached yet out of the map.
  const values: Record<string, AppConfigurationValue> = {};
  for (const field of manifest.configuration.fields) {
    if (field.type === "connection_slot" || missing.has(field.key)) continue;
    const value = Object.hasOwn(submitted, field.key) ? submitted[field.key] : field.default;
    if (value !== undefined) values[field.key] = value as AppConfigurationValue;
  }
  return { configuration: null, values, unresolved, readiness: UNDETERMINED_READINESS };
};

const hostFromConfiguredUrl = (value: AppConfigurationValue | undefined): string | null => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
};

const byKey = <T>(items: readonly T[], key: (item: T) => string): T[] =>
  [...items].sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));

/**
 * Deterministic by construction: every list is sorted by identity and the checksum is
 * taken over canonical JSON, so the same approval re-planned on another replica yields
 * the same checksum and apply stays comparable.
 */
export const buildAppInstallationPlan = (input: AppInstallationPlanInput): AppInstallationPlanResult => {
  const manifest = input.release.manifest;
  const resolved = resolveAppConfiguration(manifest, input.configuration);
  const { values, readiness } = resolved;
  const unresolvedRequirements = [...resolved.unresolved];

  const activeIds = new Set(readiness.activeContributionIds);
  const requiredSlotIds = new Set<string>([
    ...readiness.requiredConnectionSlots,
    // A destination whose credentials are not optional cannot be called at all until its
    // slot is bound, so it is a hole in the same sense a contribution's slot is.
    ...manifest.destinations
      .filter((destination) => destination.credentials?.required === true)
      .map((destination) => destination.credentials!.slot),
  ]);
  const boundSlotIds = new Set(input.boundConnectionSlotIds);
  const connectionSlots = byKey(manifest.connections.slots, (slot: ConnectionSlot) => slot.id).map((slot) => {
    const required = requiredSlotIds.has(slot.id);
    const bound = boundSlotIds.has(slot.id);
    if (required && !bound) {
      unresolvedRequirements.push({
        code: "connection_unbound",
        path: `connections.slots.${slot.id}`,
        message: `${slot.displayName} is not bound yet.`,
      });
    }
    return { slotId: slot.id, kind: slot.kind, required, bound };
  });

  const destinations = byKey(manifest.destinations, (destination) => destination.id).map((destination) => {
    const host = destination.host.kind === "pattern"
      ? destination.host.pattern
      : hostFromConfiguredUrl(values[destination.host.field]);
    if (host === null) {
      unresolvedRequirements.push({
        code: "destination_host_unresolved",
        path: `destinations.${destination.id}`,
        message: "This destination's host comes from a configuration value that has none yet.",
      });
    }
    return {
      id: destination.id,
      host,
      protocols: [...destination.protocols],
      credentials: destination.credentials
        ? {
          slotId: destination.credentials.slot,
          mode: destination.credentials.application.mode,
          required: destination.credentials.required,
        }
        : null,
    };
  });

  const contributions = byKey(manifest.contributions, (contribution) => contribution.id).map((contribution) => ({
    id: contribution.id,
    kind: contribution.kind,
    executionClass: executionClassForContributionKind(contribution.kind),
    availability: contribution.availability,
    active: activeIds.has(contribution.id),
  }));

  const storageCollections = byKey(manifest.storageCollections, (collection) => collection.id)
    .map((collection) => collection.id);

  const grants: AppPlannedGrant[] = byKey(
    [
      ...manifest.permissions.map((permission) => ({ kind: "permission" as const, key: permission })),
      ...destinations.map((destination) => ({ kind: "destination" as const, key: destination.id })),
      ...storageCollections.map((collectionId) => ({ kind: "collection" as const, key: collectionId })),
      ...contributions.map((contribution) => ({ kind: "contribution" as const, key: contribution.id })),
    ],
    (grant) => `${grant.kind}:${grant.key}`,
  );

  const plan: AppInstallationPlan = {
    planVersion: 1,
    workspaceId: input.workspaceId,
    releaseId: input.release.id,
    appId: input.release.appId,
    version: input.release.version,
    manifestDigest: input.release.manifestDigest,
    configuration: values,
    grants,
    destinations,
    storageCollections,
    contributions,
    connectionSlots,
    targetAgentIds: [...input.targetAgentIds].sort(),
    unresolvedRequirements: byKey(unresolvedRequirements, (requirement) => requirement.path),
  };

  return {
    plan,
    checksum: canonicalDigest(plan),
    expiresAt: new Date(input.now.getTime() + APP_INSTALLATION_PLAN_TTL_MS),
  };
};

interface AppPlanApplicabilityInput {
  readonly plan: { readonly checksum: string; readonly expiresAt: Date; readonly consumedAt: Date | null };
  readonly submittedChecksum: string;
  readonly expectedInstallationVersion: number | null;
  readonly currentInstallationVersion: number | null;
  readonly now: Date;
}

/**
 * Apply is bound to the exact plan an operator approved (FR-024). Every kind of drift is
 * one reason — the plan is stale — with a bounded cause so the dashboard can say which.
 */
export const assertAppPlanApplicable = (input: AppPlanApplicabilityInput): void => {
  const stale = (cause: string, message: string): never => {
    throw new AppsError("plan_stale", message, { cause });
  };
  if (input.plan.checksum !== input.submittedChecksum) {
    stale("checksum_mismatch", "This plan no longer matches the one that was approved.");
  }
  if (input.plan.consumedAt !== null) {
    stale("consumed", "This plan has already been applied.");
  }
  if (input.plan.expiresAt.getTime() <= input.now.getTime()) {
    stale("expired", "This plan has expired and needs a fresh review.");
  }
  if (
    input.expectedInstallationVersion !== null
    && input.expectedInstallationVersion !== input.currentInstallationVersion
  ) {
    stale("version_mismatch", "The installation changed since this plan was reviewed.");
  }
};
