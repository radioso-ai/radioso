import type { StorageCollection, StorageOperation } from "@radioso/app-contract";

/**
 * A collection's `allowedOperations` is the App's own declaration of what it
 * will do with the data, and the operator approved that list at install. An
 * operation outside it is denied even though the App holds the storage
 * permission.
 */
export const isOperationAllowed = (collection: StorageCollection, operation: StorageOperation): boolean =>
  collection.allowedOperations.includes(operation);

/**
 * A request names the collection it targets, and the caller supplies the
 * declaration it resolved for that name. A mismatch means the request is for a
 * collection this installation has no declaration for.
 */
export const namesDeclaredCollection = (collection: StorageCollection, requested: string): boolean =>
  collection.id === requested;
