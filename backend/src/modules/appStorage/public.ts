/**
 * The `appStorage` module's only import surface.
 *
 * Managed App Storage is Radioso-owned and generic: an App declares logical
 * collections in its manifest and never sees a table, an index, or a query plan.
 * What leaves this module is scoped record operations, the compatibility check
 * release admission asks for together with the index rebuild it can require, and
 * the disposition and maintenance operations an operator drives.
 */
export { evaluateStorageCompatibility } from "./domain/compatibility.js";
export { resolveTtlSeconds } from "./domain/expiry.js";
export { buildStorageIndexEntries } from "./domain/indexEntries.js";
export {
  INDEXED_STRING_BYTE_BOUND,
  INDEXED_STRING_CHARACTER_BOUND,
} from "./domain/indexedValueBounds.js";
export { resolveStorageQuery } from "./domain/queryBounds.js";
export { validateStorageRecord } from "./domain/recordValidation.js";
export { MAX_RETENTION_DAYS } from "./domain/retention.js";

export type { StorageCompatibilityInput } from "./domain/compatibility.js";
export type { AppStorageAuditEvent, AppStorageAuditPort } from "./ports/appStorageAudit.js";
export type {
  AppStorageCollectionScope,
  AppStorageInstallationScope,
  AppStorageRepositoryPort,
  StoredAppStorageRecord,
} from "./ports/appStorageRepository.js";
export type {
  AppStorageDisposition,
  AppStorageIndexRebuilder,
  AppStorageService,
  AppStorageSweeper,
} from "./ports/appStorageService.js";

export { createAppStorageService } from "./services/appStorageService.js";
export { createAppStorageDisposition } from "./services/appStorageDisposition.js";
export { createAppStorageIndexRebuilder } from "./services/appStorageIndexRebuilder.js";
export { createAppStorageSweeper } from "./services/appStorageSweeper.js";
export { AppStorageRepository } from "./repositories/appStorageRepository.js";
