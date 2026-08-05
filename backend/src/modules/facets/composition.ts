import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import type { FacetExtractionJobStore, FacetExtractionPort } from "./contracts.js";
import { FacetExtractionWorker } from "./services/facetExtractionWorker.js";

export type {
  FacetExtractionEnqueueResult,
  FacetExtractionInferenceFactory,
  FacetExtractionJob,
  FacetExtractionJobStatus,
  FacetExtractionJobStore,
  FacetExtractionOutcome,
  FacetExtractionPort,
  FacetSourceMessagePort,
  MessageFacetRepositoryPort,
} from "./contracts.js";
export { FacetExtractionWorker } from "./services/facetExtractionWorker.js";
export {
  FacetExtractionService,
  type FacetExtractionServiceDependencies,
} from "./services/facetExtractionService.js";
export {
  FACET_EXTRACTION_PROMPT_VERSION,
  FacetExtractionValidationError,
} from "./services/prompt.js";

/**
 * Builds the facet extraction worker, or `undefined` when no extraction implementation
 * is registered.
 *
 * Returning `undefined` is the deliberate default: with no extractor, draining the queue
 * could only discard work. Leaving jobs queued keeps them durable until an extractor is
 * registered, at which point the backlog is processed.
 */
export const createFacetExtractionWorker = (input: {
  jobs: FacetExtractionJobStore;
  extraction?: FacetExtractionPort;
  logger: AppLogger;
  pollIntervalMs: number;
  batchSize: number;
  jobLeaseMs: number;
  telemetryService?: TelemetryService;
  errorReporter?: ErrorReporter;
}): FacetExtractionWorker | undefined => {
  if (!input.extraction) {
    return undefined;
  }
  return new FacetExtractionWorker({
    jobs: input.jobs,
    extraction: input.extraction,
    logger: input.logger,
    pollIntervalMs: input.pollIntervalMs,
    batchSize: input.batchSize,
    jobLeaseMs: input.jobLeaseMs,
    telemetryService: input.telemetryService,
    errorReporter: input.errorReporter,
  });
};
