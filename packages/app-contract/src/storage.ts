import { z } from "zod";

import { boundedJsonRecordSchema, MAX_JSON_SERIALIZED_BYTES } from "./bounds.js";
import { collectionIdSchema, fieldKeySchema, indexIdSchema, timestampSchema } from "./identifiers.js";

/**
 * Storage is Radioso-owned and generic. An App declares logical collections and
 * the host keeps the rows, scoped to one installation inside one workspace.
 */
export const storageFieldTypes = ["string", "number", "boolean", "timestamp", "json"] as const;
export const storageFieldTypeSchema = z.enum(storageFieldTypes);

/** An index compares one value per key, so only these types can carry one. */
export const scalarStorageFieldTypes = ["string", "number", "boolean", "timestamp"] as const;

export const storageOperations = ["get", "put", "delete", "query_by_index"] as const;
export const storageOperationSchema = z.enum(storageOperations);

export const isScalarStorageFieldType = (type: string): boolean =>
  (scalarStorageFieldTypes as readonly string[]).includes(type);

export const storageRecordFieldSchema = z
  .object({
    key: fieldKeySchema,
    type: storageFieldTypeSchema,
    required: z.boolean(),
  })
  .strict();

export const storageIndexSchema = z
  .object({
    id: indexIdSchema,
    field: fieldKeySchema,
  })
  .strict();

export const storageRetentionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("ttl"), seconds: z.number().int().min(60).max(31_536_000) }).strict(),
]);

export const storageCollectionSchema = z
  .object({
    id: collectionIdSchema,
    scope: z.literal("installation"),
    schemaVersion: z.number().int().min(1),
    compatibleReaderVersions: z.array(z.number().int().min(1)).min(1).max(8),
    recordSchema: z
      .object({
        fields: z.array(storageRecordFieldSchema).min(1).max(64),
      })
      .strict(),
    indexes: z.array(storageIndexSchema).max(8).default([]),
    /**
     * `maxRecordBytes` stops at the serialized ceiling every protocol message
     * shares. A collection admitted above it would promise capacity the wire
     * refuses, so the first oversized record would fail at the boundary rather
     * than against the quota the operator approved.
     */
    quotas: z
      .object({
        maxRecords: z.number().int().min(1).max(1_000_000),
        maxRecordBytes: z.number().int().min(1).max(MAX_JSON_SERIALIZED_BYTES),
      })
      .strict(),
    retention: storageRetentionSchema,
    allowedOperations: z.array(storageOperationSchema).min(1).max(storageOperations.length),
  })
  .strict()
  .superRefine((collection, context) => {
    if (!collection.compatibleReaderVersions.includes(collection.schemaVersion)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compatibleReaderVersions"],
        message: "A collection must list its own schema version among the versions a reader may use",
      });
    }
  });

/** A scalar an index can be queried by. */
export const storageScalarValueSchema = z.union([
  z.string().max(2048),
  z.number().finite(),
  z.boolean(),
]);

/**
 * A stored record's value space is the App's, so the contract bounds its size
 * rather than its meaning.
 */
export const storageRecordValueSchema = boundedJsonRecordSchema;

export const storageKeySchema = z.string().min(1).max(256);
export const storageVersionSchema = z.number().int().min(1);

export const storageGetRequestSchema = z
  .object({
    collection: collectionIdSchema,
    key: storageKeySchema,
  })
  .strict();

export const storagePutRequestSchema = z
  .object({
    collection: collectionIdSchema,
    key: storageKeySchema,
    record: storageRecordValueSchema,
    expectedVersion: storageVersionSchema.optional(),
  })
  .strict();

export const storageDeleteRequestSchema = z
  .object({
    collection: collectionIdSchema,
    key: storageKeySchema,
    expectedVersion: storageVersionSchema.optional(),
  })
  .strict();

export const storageQueryRequestSchema = z
  .object({
    collection: collectionIdSchema,
    index: indexIdSchema,
    equals: storageScalarValueSchema,
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const storageRecordSchema = z
  .object({
    key: storageKeySchema,
    version: storageVersionSchema,
    updatedAt: timestampSchema,
    record: storageRecordValueSchema,
  })
  .strict();

export const storageQueryResultSchema = z
  .object({
    records: z.array(storageRecordSchema).max(200),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export type StorageFieldType = z.infer<typeof storageFieldTypeSchema>;
export type StorageOperation = z.infer<typeof storageOperationSchema>;
export type StorageCollection = z.infer<typeof storageCollectionSchema>;
export type StorageGetRequest = z.infer<typeof storageGetRequestSchema>;
export type StoragePutRequest = z.infer<typeof storagePutRequestSchema>;
export type StorageDeleteRequest = z.infer<typeof storageDeleteRequestSchema>;
export type StorageQueryRequest = z.infer<typeof storageQueryRequestSchema>;
export type StorageRecord = z.infer<typeof storageRecordSchema>;
export type StorageQueryResult = z.infer<typeof storageQueryResultSchema>;
