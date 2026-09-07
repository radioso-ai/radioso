import { z } from "zod";

import { appConfigurationSchema } from "./configuration.js";
import { appConnectionsSchema } from "./connections.js";
import { contributionSchema, hostPermissionSchema, hostPermissions } from "./contributions.js";
import { destinationSchema } from "./destinations.js";
import {
  appIdSchema,
  contributionIdSchema,
  descriptionSchema,
  digestSchema,
  displayNameSchema,
  fixtureIdSchema,
  semanticVersionRangeSchema,
  semanticVersionSchema,
} from "./identifiers.js";
import { RUNTIME_PROTOCOL_VERSION } from "./runtime.js";
import { companionAssetSchema, setupGuideSchema } from "./setup.js";
import { storageCollectionSchema } from "./storage.js";

export const MANIFEST_SCHEMA_VERSION = 1;

/** How the App's program is shipped. */
export const artifactMediaTypes = [
  "application/vnd.radioso.app.node-bundle.v1+tar",
  "application/vnd.oci.image.manifest.v1+json",
] as const;
export const artifactMediaTypeSchema = z.enum(artifactMediaTypes);

export const appArtifactSchema = z
  .object({
    digest: digestSchema,
    mediaType: artifactMediaTypeSchema,
    entrypoint: z.string().min(1).max(256).optional(),
  })
  .strict();

export const resourceProfileSchema = z
  .object({
    memoryMb: z.number().int().min(64).max(4096),
    cpuMillis: z.number().int().min(100).max(4000),
    maxConcurrentInvocations: z.number().int().min(1).max(64),
    scratchMb: z.number().int().min(0).max(4096),
  })
  .strict();

/** A recorded case the conformance harness replays against the App's contributions. */
export const conformanceFixtureSchema = z
  .object({
    id: fixtureIdSchema,
    contributionId: contributionIdSchema,
    description: descriptionSchema,
    path: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u).max(256),
  })
  .strict();

export const appManifestSchema = z
  .object({
    manifestSchemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    /**
     * The wire protocol this release's artifact implements. It moves
     * independently of the manifest's own schema, so admission establishes that
     * an artifact speaks a protocol this host still runs.
     */
    runtimeProtocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    app: z
      .object({
        id: appIdSchema,
        name: displayNameSchema,
        description: descriptionSchema,
        publisher: z.object({ id: appIdSchema, name: displayNameSchema }).strict(),
      })
      .strict(),
    version: semanticVersionSchema,
    radiosoCompatibility: semanticVersionRangeSchema,
    artifact: appArtifactSchema,
    permissions: z.array(hostPermissionSchema).max(hostPermissions.length).default([]),
    configuration: appConfigurationSchema.default({ fields: [] }),
    connections: appConnectionsSchema.default({ slots: [] }),
    destinations: z.array(destinationSchema).max(16).default([]),
    storageCollections: z.array(storageCollectionSchema).max(16).default([]),
    contributions: z.array(contributionSchema).min(1).max(32),
    resourceProfile: resourceProfileSchema,
    setupGuide: setupGuideSchema.optional(),
    companionAssets: z.array(companionAssetSchema).max(8).optional(),
    conformanceFixtures: z.array(conformanceFixtureSchema).max(64).default([]),
  })
  .strict();

export type AppArtifact = z.infer<typeof appArtifactSchema>;
export type ResourceProfile = z.infer<typeof resourceProfileSchema>;
export type ConformanceFixture = z.infer<typeof conformanceFixtureSchema>;
export type AppManifest = z.infer<typeof appManifestSchema>;
