/**
 * The `appStorage` module's only import surface.
 *
 * Managed App Storage is Radioso-owned and generic: an App declares logical
 * collections in its manifest and never sees a table, an index, or a query plan.
 * What leaves this module is scoped record operations, the compatibility check
 * release admission asks for, and the disposition operations an operator drives.
 */
export { evaluateStorageCompatibility } from "./domain/compatibility.js";
export { isExpired, resolveExpiresAt } from "./domain/expiry.js";
export { buildStorageIndexEntries } from "./domain/indexEntries.js";
export { resolveStorageQuery } from "./domain/queryBounds.js";
export { validateStorageRecord } from "./domain/recordValidation.js";

export type { AppStorageAuditEvent, AppStorageAuditPort } from "./ports/appStorageAudit.js";
export type {
  AppStorageRepositoryPort,
  StoredAppStorageRecord,
} from "./ports/appStorageRepository.js";
export type {
  AppStorageDisposition,
  AppStorageExpirySweeper,
  AppStorageService,
} from "./ports/appStorageService.js";

export { createAppStorageService } from "./services/appStorageService.js";
export { createAppStorageDisposition } from "./services/appStorageDisposition.js";
export { createAppStorageExpirySweeper } from "./services/appStorageExpirySweeper.js";
export { AppStorageRepository } from "./repositories/appStorageRepository.js";
