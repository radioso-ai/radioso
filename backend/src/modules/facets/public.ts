/**
 * Cross-module surface for the facets module. Other modules — chiefly `chat`, which
 * enqueues extraction on eligible visitor message write — depend on this file rather
 * than `contracts.ts` or `composition.ts` directly, per the repository's cross-module
 * boundary rule (`scripts/validate-architecture-boundaries.mjs`).
 */
export type {
  FacetExtractionJobStore,
} from "./contracts.js";
