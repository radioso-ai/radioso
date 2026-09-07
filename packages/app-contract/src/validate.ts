import type { ZodIssue } from "zod";

import type { ConfigurationField } from "./configuration.js";
import type { ConnectionSlot, ConnectionSlotKind } from "./connections.js";
import {
  releaseAContributionKinds,
  type ConfigurationSchedule,
  type ContributionKind,
  type ExternalWebhookHandlerContribution,
  type HostPermission,
  type ScheduledTaskContribution,
  hostPermissions,
} from "./contributions.js";
import { credentialFieldReferences, type Destination } from "./destinations.js";
import { appManifestSchema, type AppManifest } from "./manifest.js";
import { isScalarStorageFieldType } from "./storage.js";

export interface ManifestValidationIssue {
  /** Stable, snake_case, safe to branch on and to surface in an audit record. */
  code: string;
  /** Dot and bracket path into the manifest, such as `contributions[1].kind`. */
  path: string;
  message: string;
}

export interface ManifestValidationPolicy {
  supportedContributionKinds: readonly ContributionKind[];
  supportedConnectionKinds: readonly ConnectionSlotKind[];
  supportedPermissions: readonly HostPermission[];
}

export type ManifestValidationResult =
  | { ok: true; manifest: AppManifest }
  | { ok: false; issues: ManifestValidationIssue[] };

/** What a Release A host admits. */
export const releaseAValidationPolicy: ManifestValidationPolicy = {
  supportedContributionKinds: releaseAContributionKinds,
  supportedConnectionKinds: ["secret_fields", "generated_secret"],
  supportedPermissions: hostPermissions,
};

const formatPath = (segments: ReadonlyArray<string | number>): string =>
  segments.reduce<string>(
    (path, segment) =>
      typeof segment === "number" ? `${path}[${segment}]` : path === "" ? segment : `${path}.${segment}`,
    "",
  );

const schemaIssue = (issue: ZodIssue): ManifestValidationIssue => ({
  code: "schema",
  path: formatPath(issue.path),
  message: issue.message,
});

const duplicateIssues = <T>(
  items: readonly T[],
  identify: (item: T) => string,
  pathFor: (index: number) => string,
): ManifestValidationIssue[] => {
  const seen = new Set<string>();
  const issues: ManifestValidationIssue[] = [];
  items.forEach((item, index) => {
    const id = identify(item);
    if (seen.has(id)) {
      issues.push({ code: "duplicate_id", path: pathFor(index), message: `Duplicate id ${id}` });
      return;
    }
    seen.add(id);
  });
  return issues;
};

const collectDuplicateIds = (manifest: AppManifest): ManifestValidationIssue[] => [
  ...duplicateIssues(
    manifest.configuration.fields,
    (field) => field.key,
    (index) => `configuration.fields[${index}].key`,
  ),
  ...duplicateIssues(manifest.connections.slots, (slot) => slot.id, (index) => `connections.slots[${index}].id`),
  ...duplicateIssues(manifest.destinations, (destination) => destination.id, (index) => `destinations[${index}].id`),
  ...duplicateIssues(
    manifest.storageCollections,
    (collection) => collection.id,
    (index) => `storageCollections[${index}].id`,
  ),
  ...manifest.storageCollections.flatMap((collection, collectionIndex) =>
    duplicateIssues(
      collection.indexes,
      (index) => index.id,
      (index) => `storageCollections[${collectionIndex}].indexes[${index}].id`,
    ),
  ),
  ...duplicateIssues(
    manifest.contributions,
    (contribution) => contribution.id,
    (index) => `contributions[${index}].id`,
  ),
  ...duplicateIssues(
    manifest.companionAssets ?? [],
    (asset) => asset.id,
    (index) => `companionAssets[${index}].id`,
  ),
  ...duplicateIssues(
    manifest.conformanceFixtures,
    (fixture) => fixture.id,
    (index) => `conformanceFixtures[${index}].id`,
  ),
  ...manifest.connections.slots.flatMap((slot, slotIndex) =>
    slot.kind === "secret_fields"
      ? duplicateIssues(
          slot.fields,
          (field) => field.key,
          (index) => `connections.slots[${slotIndex}].fields[${index}].key`,
        )
      : [],
  ),
  ...manifest.storageCollections.flatMap((collection, collectionIndex) =>
    duplicateIssues(
      collection.recordSchema.fields,
      (field) => field.key,
      (index) => `storageCollections[${collectionIndex}].recordSchema.fields[${index}].key`,
    ),
  ),
];

interface ManifestIndex {
  configurationFields: ReadonlyMap<string, ConfigurationField>;
  connectionSlots: ReadonlyMap<string, ConnectionSlot>;
  destinationsById: ReadonlyMap<string, Destination>;
  collectionIds: ReadonlySet<string>;
  contributionKindsById: ReadonlyMap<string, ContributionKind>;
}

const indexManifest = (manifest: AppManifest): ManifestIndex => ({
  configurationFields: new Map(manifest.configuration.fields.map((field) => [field.key, field])),
  connectionSlots: new Map(manifest.connections.slots.map((slot) => [slot.id, slot])),
  destinationsById: new Map(manifest.destinations.map((destination) => [destination.id, destination])),
  collectionIds: new Set(manifest.storageCollections.map((collection) => collection.id)),
  contributionKindsById: new Map(
    manifest.contributions.map((contribution) => [contribution.id, contribution.kind]),
  ),
});

const collectStorageIssues = (manifest: AppManifest): ManifestValidationIssue[] =>
  manifest.storageCollections.flatMap((collection, collectionIndex) =>
    collection.indexes.flatMap((index, indexPosition) => {
      const path = `storageCollections[${collectionIndex}].indexes[${indexPosition}].field`;
      const field = collection.recordSchema.fields.find((candidate) => candidate.key === index.field);
      if (!field) {
        return [
          {
            code: "unknown_index_field",
            path,
            message: `Collection ${collection.id} has no field ${index.field} to index`,
          },
        ];
      }
      if (!isScalarStorageFieldType(field.type)) {
        return [
          {
            code: "non_scalar_index_field",
            path,
            message: `Field ${index.field} is ${field.type} and cannot carry an index`,
          },
        ];
      }
      return [];
    }),
  );

/**
 * A handler that writes documents has to say whose namespace, indexed-field
 * vocabulary, and provenance the write belongs to, and the named contribution
 * has to be a source that owns one.
 */
const collectDocumentSourceIssues = (
  contributionId: string,
  documentSources: readonly string[],
  index: ManifestIndex,
  at: (suffix: string) => string,
): ManifestValidationIssue[] =>
  documentSources.flatMap((sourceId, position) => {
    const path = at(`documentSources[${position}]`);
    const kind = index.contributionKindsById.get(sourceId);
    if (kind === undefined) {
      return [
        {
          code: "unknown_document_source",
          path,
          message: `No contribution ${sourceId} is declared`,
        },
      ];
    }
    if (kind !== "document_source") {
      return [
        {
          code: "not_a_document_source",
          path,
          message: `Contribution ${contributionId} writes through ${sourceId}, which is a ${kind}`,
        },
      ];
    }
    return [];
  });

const collectConformanceFixtureIssues = (
  manifest: AppManifest,
  index: ManifestIndex,
): ManifestValidationIssue[] =>
  manifest.conformanceFixtures.flatMap((fixture, position) =>
    index.contributionKindsById.has(fixture.contributionId)
      ? []
      : [
          {
            code: "unknown_contribution",
            path: `conformanceFixtures[${position}].contributionId`,
            message: `No contribution ${fixture.contributionId} is declared for fixture ${fixture.id}`,
          },
        ],
  );

const collectConfigurationIssues = (
  manifest: AppManifest,
  index: ManifestIndex,
): ManifestValidationIssue[] =>
  manifest.configuration.fields.flatMap((field, position) => {
    if (field.type !== "connection_slot") return [];
    if (index.connectionSlots.has(field.connectionSlot)) return [];
    return [
      {
        code: "unknown_connection_slot",
        path: `configuration.fields[${position}].connectionSlot`,
        message: `No connection slot ${field.connectionSlot} is declared`,
      },
    ];
  });

/**
 * Two destinations built from one configuration field are two views of one
 * address the operator types once. If they declare no protocol in common, every
 * value that satisfies one fails the other, and the manifest describes an
 * installation that cannot exist — which an author learns at admission here
 * rather than an operator learns by trying every URL.
 */
const collectSharedHostIssues = (manifest: AppManifest): ManifestValidationIssue[] => {
  const issues: ManifestValidationIssue[] = [];
  const reached = new Map<string, { id: string; protocols: Set<string> }>();
  manifest.destinations.forEach((destination, position) => {
    if (destination.host.kind !== "configuration") return;
    const field = destination.host.field;
    const seen = reached.get(field);
    if (!seen) {
      reached.set(field, { id: destination.id, protocols: new Set(destination.protocols) });
      return;
    }
    const shared = destination.protocols.filter((protocol) => seen.protocols.has(protocol));
    if (shared.length > 0) {
      seen.protocols = new Set(shared);
      return;
    }
    issues.push({
      code: "destination_protocols_incompatible",
      path: `destinations[${position}].protocols`,
      message: `Destinations ${seen.id} and ${destination.id} are built from field ${field} and share no protocol`,
    });
  });
  return issues;
};

const collectDestinationIssues = (
  manifest: AppManifest,
  index: ManifestIndex,
): ManifestValidationIssue[] =>
  manifest.destinations.flatMap((destination, position) => {
    const issues: ManifestValidationIssue[] = [];
    if (destination.host.kind === "configuration") {
      const path = `destinations[${position}].host.field`;
      const field = index.configurationFields.get(destination.host.field);
      if (!field) {
        issues.push({
          code: "unknown_configuration_field",
          path,
          message: `No configuration field ${destination.host.field} is declared`,
        });
      } else if (field.type !== "url") {
        issues.push({
          code: "destination_host_field_not_url",
          path,
          message: `Configuration field ${field.key} is ${field.type}; a destination host must come from a url field`,
        });
      }
    }
    if (destination.credentials) {
      const credentials = destination.credentials;
      const slotPath = `destinations[${position}].credentials.slot`;
      const slot = index.connectionSlots.get(credentials.slot);
      if (!destination.dataClasses.includes("credentials")) {
        issues.push({
          code: "missing_credentials_data_class",
          path: `destinations[${position}].dataClasses`,
          message: `Destination ${destination.id} sends a credential, which the operator sees only if it says so`,
        });
      }
      if (!slot) {
        issues.push({
          code: "unknown_connection_slot",
          path: slotPath,
          message: `No connection slot ${credentials.slot} is declared`,
        });
      } else if (slot.kind !== "secret_fields") {
        issues.push({
          code: "invalid_destination_credential_slot",
          path: slotPath,
          message: `Slot ${slot.id} is ${slot.kind} and holds no fields a request can be built from`,
        });
      } else {
        const fields = new Map(slot.fields.map((field) => [field.key, field]));
        for (const reference of credentialFieldReferences(credentials.application)) {
          const path = `destinations[${position}].credentials.application.${reference.path}`;
          const field = fields.get(reference.field);
          if (!field) {
            issues.push({
              code: "unknown_connection_field",
              path,
              message: `Slot ${slot.id} has no field ${reference.field}`,
            });
            continue;
          }
          if (!field.required) {
            issues.push({
              code: "credential_field_not_required",
              path,
              message: `Field ${field.key} builds every request to ${destination.id}, so a bound slot always holds it`,
            });
          }
          if (reference.secret && !field.sensitive) {
            issues.push({
              code: "credential_field_not_sensitive",
              path,
              message: `Field ${field.key} carries the secret half of a credential and is stored as one`,
            });
          }
        }
      }
    }
    return issues;
  });

const SECRET_BEARING_SLOT_KINDS: readonly ConnectionSlotKind[] = ["secret_fields", "generated_secret"];

/**
 * A schedule an operator reads out of configuration is only a schedule if the
 * field can hold the values it means. A field whose range excludes the sentinel
 * leaves a task nobody can turn off; a field whose range never meets the
 * interval range leaves one that can never run. Both parse cleanly on their own
 * and only contradict each other here.
 */
const collectScheduleRangeIssues = (
  schedule: ConfigurationSchedule,
  field: Extract<ConfigurationField, { type: "number" }>,
  at: (suffix: string) => string,
): ManifestValidationIssue[] => {
  const issues: ManifestValidationIssue[] = [];
  const floor = field.min;
  const ceiling = field.max;
  const disabled = schedule.disabledValue;
  if (
    disabled !== undefined &&
    ((floor !== undefined && disabled < floor) || (ceiling !== undefined && disabled > ceiling))
  ) {
    issues.push({
      code: "disabled_value_outside_field_range",
      path: at("schedule.disabledValue"),
      message: `Field ${field.key} cannot hold ${disabled}, so this schedule can never be turned off`,
    });
  }
  const reachableFloor = Math.max(floor ?? schedule.minSeconds, schedule.minSeconds);
  const reachableCeiling = Math.min(ceiling ?? schedule.maxSeconds, schedule.maxSeconds);
  if (reachableFloor > reachableCeiling) {
    issues.push({
      code: "schedule_range_unreachable",
      path: at("schedule.minSeconds"),
      message: `Field ${field.key} admits no value between ${schedule.minSeconds} and ${schedule.maxSeconds} seconds, so this schedule can never run`,
    });
  }
  return issues;
};

/**
 * A contribution the installation cannot run without is one the operator never
 * turns off, so a sentinel that says "do not run this" contradicts the
 * availability beside it. Refusing the pair here is what keeps a dashboard, an
 * installation plan, and a scheduler from each picking a different winner.
 */
const collectRequiredScheduleIssues = (
  contribution: ScheduledTaskContribution,
  schedule: ConfigurationSchedule,
  at: (suffix: string) => string,
): ManifestValidationIssue[] =>
  contribution.availability === "required" && schedule.disabledValue !== undefined
    ? [
        {
          code: "required_schedule_cannot_disable",
          path: at("schedule.disabledValue"),
          message: `Contribution ${contribution.id} is required, so it holds no value that turns it off`,
        },
      ]
    : [];

/**
 * Which field of a multi-field slot carries the signing key. A one-value slot
 * answers that by being named; a `secret_fields` slot does not, and a gateway
 * that guessed would be reading an App's field naming as a protocol.
 */
const collectWebhookSecretFieldIssues = (
  authentication: ExternalWebhookHandlerContribution["authentication"],
  slot: ConnectionSlot,
  at: (suffix: string) => string,
): ManifestValidationIssue[] => {
  const path = at("authentication.secretField");
  if (slot.kind !== "secret_fields") {
    return authentication.secretField === undefined
      ? []
      : [
          {
            code: "webhook_secret_field_not_allowed",
            path,
            message: `Slot ${slot.id} holds one value, which is the signing key`,
          },
        ];
  }
  if (authentication.secretField === undefined) {
    return [
      {
        code: "webhook_secret_field_required",
        path,
        message: `Slot ${slot.id} holds several fields, so this handler names the one that carries the signing key`,
      },
    ];
  }
  const field = slot.fields.find((candidate) => candidate.key === authentication.secretField);
  if (!field) {
    return [
      {
        code: "unknown_connection_field",
        path,
        message: `Slot ${slot.id} has no field ${authentication.secretField}`,
      },
    ];
  }
  const issues: ManifestValidationIssue[] = [];
  if (!field.required) {
    issues.push({
      code: "credential_field_not_required",
      path,
      message: `Field ${field.key} verifies every delivery, so a bound slot always holds it`,
    });
  }
  if (!field.sensitive) {
    issues.push({
      code: "credential_field_not_sensitive",
      path,
      message: `Field ${field.key} is a signing key and is stored as one`,
    });
  }
  return issues;
};


const collectContributionIssues = (
  manifest: AppManifest,
  index: ManifestIndex,
): ManifestValidationIssue[] =>
  manifest.contributions.flatMap((contribution, position) => {
    const issues: ManifestValidationIssue[] = [];
    const at = (suffix: string): string => `contributions[${position}].${suffix}`;

    const requiredSlots = new Set<string>(contribution.requiredConnectionSlots);

    contribution.egressDestinations.forEach((destinationId, destinationPosition) => {
      const destination = index.destinationsById.get(destinationId);
      if (!destination) {
        issues.push({
          code: "unknown_destination",
          path: at(`egressDestinations[${destinationPosition}]`),
          message: `No destination ${destinationId} is declared`,
        });
        return;
      }
      const credentials = destination.credentials;
      if (!credentials?.required || requiredSlots.has(credentials.slot)) return;
      issues.push({
        code: "destination_credentials_not_required",
        path: at("requiredConnectionSlots"),
        message: `Destination ${destination.id} is never reachable unbound, so ${contribution.id} requires slot ${credentials.slot}`,
      });
    });

    contribution.permissions.forEach((permission, permissionPosition) => {
      if (manifest.permissions.includes(permission)) return;
      issues.push({
        code: "permission_not_declared",
        path: at(`permissions[${permissionPosition}]`),
        message: `Contribution ${contribution.id} asks for ${permission}, which the manifest does not declare`,
      });
    });

    const requireCollection = (collectionId: string, path: string): void => {
      if (index.collectionIds.has(collectionId)) return;
      issues.push({
        code: "unknown_collection",
        path,
        message: `No storage collection ${collectionId} is declared`,
      });
    };

    if (contribution.kind === "document_source" && contribution.backfill) {
      requireCollection(contribution.backfill.checkpointCollection, at("backfill.checkpointCollection"));
    }

    contribution.requiredConnectionSlots.forEach((slotId, slotPosition) => {
      if (index.connectionSlots.has(slotId)) return;
      issues.push({
        code: "unknown_connection_slot",
        path: at(`requiredConnectionSlots[${slotPosition}]`),
        message: `No connection slot ${slotId} is declared`,
      });
    });

    if (contribution.kind === "external_webhook_handler" || contribution.kind === "scheduled_task") {
      const writesDocuments = contribution.permissions.some(
        (permission) => permission === "documents.ingest" || permission === "documents.delete",
      );
      if (writesDocuments && contribution.documentSources.length === 0) {
        issues.push({
          code: "missing_document_source",
          path: at("documentSources"),
          message: `Contribution ${contribution.id} writes documents and names no source to write through`,
        });
      }
      issues.push(
        ...duplicateIssues(
          contribution.documentSources,
          (sourceId) => sourceId,
          (sourcePosition) => at(`documentSources[${sourcePosition}]`),
        ),
      );
      issues.push(
        ...collectDocumentSourceIssues(contribution.id, contribution.documentSources, index, at),
      );
    }

    if (contribution.kind === "external_webhook_handler") {
      const path = at("authentication.secretConnectionSlot");
      const slot = index.connectionSlots.get(contribution.authentication.secretConnectionSlot);
      if (!slot) {
        issues.push({
          code: "unknown_connection_slot",
          path,
          message: `No connection slot ${contribution.authentication.secretConnectionSlot} is declared`,
        });
      } else if (!SECRET_BEARING_SLOT_KINDS.includes(slot.kind)) {
        issues.push({
          code: "invalid_webhook_secret_slot",
          path,
          message: `Slot ${slot.id} is ${slot.kind} and cannot hold a signing secret`,
        });
      } else {
        issues.push(...collectWebhookSecretFieldIssues(contribution.authentication, slot, at));
      }
      if (!requiredSlots.has(contribution.authentication.secretConnectionSlot)) {
        issues.push({
          code: "webhook_secret_not_required",
          path: at("requiredConnectionSlots"),
          message: `Contribution ${contribution.id} verifies every delivery against slot ${contribution.authentication.secretConnectionSlot}, so it requires it`,
        });
      }
    }

    if (contribution.kind === "scheduled_task") {
      if (contribution.schedule.kind === "interval_from_configuration") {
        const path = at("schedule.field");
        const field = index.configurationFields.get(contribution.schedule.field);
        if (!field) {
          issues.push({
            code: "unknown_configuration_field",
            path,
            message: `No configuration field ${contribution.schedule.field} is declared`,
          });
        } else if (field.type !== "number") {
          issues.push({
            code: "interval_field_not_number",
            path,
            message: `Configuration field ${field.key} is ${field.type}; an interval must come from a number field`,
          });
        } else {
          issues.push(...collectScheduleRangeIssues(contribution.schedule, field, at));
        }
        issues.push(...collectRequiredScheduleIssues(contribution, contribution.schedule, at));
      }
      if (contribution.checkpointCollection !== undefined) {
        requireCollection(contribution.checkpointCollection, at("checkpointCollection"));
      }
    }

    return issues;
  });

const collectPolicyIssues = (
  manifest: AppManifest,
  policy: ManifestValidationPolicy,
): ManifestValidationIssue[] => [
  ...manifest.permissions.flatMap((permission, position) =>
    policy.supportedPermissions.includes(permission)
      ? []
      : [
          {
            code: "unsupported_permission",
            path: `permissions[${position}]`,
            message: `Permission ${permission} is not available on this host`,
          },
        ],
  ),
  ...manifest.connections.slots.flatMap((slot, position) =>
    policy.supportedConnectionKinds.includes(slot.kind)
      ? []
      : [
          {
            code: "unsupported_connection_kind",
            path: `connections.slots[${position}].kind`,
            message: `Connection kind ${slot.kind} is not available on this host`,
          },
        ],
  ),
  ...manifest.contributions.flatMap((contribution, position) =>
    policy.supportedContributionKinds.includes(contribution.kind)
      ? []
      : [
          {
            code: "unsupported_contribution_kind",
            path: `contributions[${position}].kind`,
            message: `Contribution kind ${contribution.kind} is not available on this host`,
          },
        ],
  ),
];

/**
 * Parses a manifest, then resolves every reference it makes to its own
 * declarations, then measures it against what this host admits. All three
 * passes report, so an author sees the whole list rather than one failure per
 * round trip.
 */
export const validateManifest = (
  manifest: unknown,
  policy: ManifestValidationPolicy,
): ManifestValidationResult => {
  const parsed = appManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map(schemaIssue) };
  }

  const index = indexManifest(parsed.data);
  const issues = [
    ...collectDuplicateIds(parsed.data),
    ...collectStorageIssues(parsed.data),
    ...collectConfigurationIssues(parsed.data, index),
    ...collectDestinationIssues(parsed.data, index),
    ...collectSharedHostIssues(parsed.data),
    ...collectContributionIssues(parsed.data, index),
    ...collectConformanceFixtureIssues(parsed.data, index),
    ...collectPolicyIssues(parsed.data, policy),
  ];

  return issues.length === 0 ? { ok: true, manifest: parsed.data } : { ok: false, issues };
};
