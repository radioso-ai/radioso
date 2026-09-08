import type { AppStorageResult } from "../domain/results.js";
import type { AppStorageCollectionScope } from "./appStorageRepository.js";

/**
 * What release admission has to ask storage, and nothing else.
 *
 * The compatibility matrix needs one fact only the database holds: which schema
 * versions a collection's rows actually carry. That is not a capability an App
 * calls, and it is not something the gateway may expose — a release's view of
 * storage history has nothing to do with `storage.get`. So it is its own port,
 * consumed by the lifecycle code that admits releases, and the capability
 * service stays the set of operations an App is allowed to make.
 */
export interface AppStorageCompatibilityFactsPort {
  storedSchemaVersions(scope: AppStorageCollectionScope): Promise<AppStorageResult<number[]>>;
}
