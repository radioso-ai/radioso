import { timestampSchema, type StorageCollection, type StorageQueryRequest } from "@radioso/app-contract";

import { indexColumnForFieldType, type AppStorageIndexColumn } from "./indexEntries.js";
import { isOperationAllowed } from "./operations.js";
import { storageFailure, storageSuccess, type AppStorageResult } from "./results.js";

interface ResolvedStorageQuery {
  indexId: string;
  equals: { column: AppStorageIndexColumn; value: string | number | boolean | Date };
  limit: number;
  /** The record key a page resumes after. Opaque to an App; ordering is by key. */
  cursor: string | null;
}

/**
 * Turns a query request into the one comparison the collection's declarations
 * permit. An App may query only by an index it declared, only for equality, and
 * only with a value of the indexed field's own type — so an index on a number
 * can never be probed with a string, and the page is bounded before it is read.
 */
export const resolveStorageQuery = (
  collection: StorageCollection,
  request: StorageQueryRequest,
): AppStorageResult<ResolvedStorageQuery> => {
  if (!isOperationAllowed(collection, "query_by_index")) {
    return storageFailure("denied", `Collection ${collection.id} does not allow query_by_index`);
  }

  const index = collection.indexes.find((declared) => declared.id === request.index);
  if (!index) {
    return storageFailure("invalid_input", `Collection ${collection.id} does not declare the index ${request.index}`);
  }

  const field = collection.recordSchema.fields.find((declared) => declared.key === index.field);
  const column = field ? indexColumnForFieldType(field.type) : null;
  if (!field || column === null) {
    return storageFailure("invalid_input", `Index ${index.id} does not name an indexable field`);
  }

  const typed = coerceComparison(column, request.equals);
  if (typed === null) {
    return storageFailure("invalid_input", `Index ${index.id} compares a ${field.type} value`);
  }

  return storageSuccess({
    indexId: index.id,
    equals: { column, value: typed },
    limit: request.limit,
    cursor: request.cursor ?? null,
  });
};

const coerceComparison = (
  column: AppStorageIndexColumn,
  value: string | number | boolean,
): string | number | boolean | Date | null => {
  switch (column) {
    case "text_value":
      return typeof value === "string" ? value : null;
    case "numeric_value":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "boolean_value":
      return typeof value === "boolean" ? value : null;
    case "timestamp_value": {
      if (typeof value !== "string" || !timestampSchema.safeParse(value).success) return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }
};
