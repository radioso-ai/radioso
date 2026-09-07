import type { ZodIssue } from "zod";

import type { ConfigurationField } from "./configuration.js";
import type { ConnectionSlot, ConnectionSlotKind } from "./connections.js";
import {
  releaseAContributionKinds,
  type ContributionKind,
  type HostPermission,
  hostPermissions,
} from "./contributions.js";
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
  destinationIds: ReadonlySet<string>;
  collectionIds: ReadonlySet<string>;
  contributionKindsById: ReadonlyMap<string, ContributionKind>;
}

const indexManifest = (manifest: AppManifest): ManifestIndex => ({
  configurationFields: new Map(manifest.configuration.fields.map((field) => [field.key, field])),
  connectionSlots: new Map(manifest.connections.slots.map((slot) => [slot.id, slot])),
  destinationIds: new Set(manifest.destinations.map((destination) => destination.id)),
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
    if (destination.connectionSlot !== undefined && !index.connectionSlots.has(destination.connectionSlot)) {
      issues.push({
        code: "unknown_connection_slot",
        path: `destinations[${position}].connectionSlot`,
        message: `No connection slot ${destination.connectionSlot} is declared`,
      });
    }
    return issues;
  });

const SECRET_BEARING_SLOT_KINDS: readonly ConnectionSlotKind[] = ["secret_fields", "generated_secret"];

const collectContributionIssues = (
  manifest: AppManifest,
  index: ManifestIndex,
): ManifestValidationIssue[] =>
  manifest.contributions.flatMap((contribution, position) => {
    const issues: ManifestValidationIssue[] = [];
    const at = (suffix: string): string => `contributions[${position}].${suffix}`;

    contribution.egressDestinations.forEach((destinationId, destinationPosition) => {
      if (index.destinationIds.has(destinationId)) return;
      issues.push({
        code: "unknown_destination",
        path: at(`egressDestinations[${destinationPosition}]`),
        message: `No destination ${destinationId} is declared`,
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

    if (contribution.kind === "external_webhook_handler" || contribution.kind === "scheduled_task") {
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
        }
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
    ...collectContributionIssues(parsed.data, index),
    ...collectConformanceFixtureIssues(parsed.data, index),
    ...collectPolicyIssues(parsed.data, policy),
  ];

  return issues.length === 0 ? { ok: true, manifest: parsed.data } : { ok: false, issues };
};
