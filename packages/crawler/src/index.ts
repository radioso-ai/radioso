export type {
  DocumentPublicationEnvelope,
  DocumentPublicationMetadata,
  DocumentPublisher,
  DocumentPublisherResult
} from "./types.js";
export type {
  CrawlerExecutionMode,
  CrawlerPageStatus,
  CrawlerRunStatus,
  NormalizedCrawlerPage
} from "./core/types.js";
export type {
  CrawlerRunRecord,
  CrawlerRuntimeDependencies,
  CrawlerStateStore
} from "./core/ports.js";
export type {
  AttachedCrawlerRunResult,
  AttachedCrawlerSourceInput,
  RunAttachedCrawlerParams
} from "./core/runCrawler.js";
export type { PagePublicationState, PublicationRetryResult } from "./core/publicationTracking.js";
export type { AttachedRunExecutionState } from "./core/recovery.js";
export {
  buildAttachedExternalId,
  buildDocumentPublicationEnvelope,
  processAttachedPage
} from "./core/pageProcessing.js";
export { runAttachedCrawler } from "./core/runCrawler.js";
export {
  listPagePublicationStates,
  retryPendingPublicationAttempts
} from "./core/publicationTracking.js";
export { resolveAttachedRunExecutionState } from "./core/recovery.js";
export type {
  CrawlerFrontierRepository,
  CrawlerPagesRepository,
  CrawlerPersistence,
  CrawlerPublicationAttemptsRepository,
  CrawlerRunsRepository,
  CrawlerSourcesRepository
} from "./persistence/ports.js";
export type {
  CrawlerFrontierRecord,
  CrawlerFrontierStatus,
  CrawlerPageRecord,
  CrawlerSourceRecord,
  CrawlerSourceStatus,
  CrawlerSpeedProfile,
  CrawlerTransportMode,
  PersistedCrawlerRunRecord,
  PublicationAttemptRecord,
  PublicationAttemptStatus,
  PublicationOperation,
  PublicationPublisherKind
} from "./persistence/types.js";
export { createFunctionDocumentPublisher } from "./publishing/functionDocumentPublisher.js";
export { createHttpDocumentPublisher } from "./publishing/httpDocumentPublisher.js";
export {
  buildAcceptedCandidateDecision,
  buildRejectedCandidateDecision,
  type CrawlCandidateDecision,
  type CrawlCandidateDecisionOutcome,
  type CrawlCandidateDecisionReason
} from "./transport/candidateDecision.js";
export {
  crawlSite,
  crawlSiteStream,
  type CrawledPageResult,
  type CrawlSiteParams,
  type FetchPage,
  type FetchedPage,
  type ValidateNavigationUrl
} from "./transport/crawler.js";
export {
  fetchPageWithPlaywright,
  fetchPageWithScreenshot,
  isPlaywrightAvailable,
  type FetchedPageWithScreenshot
} from "./transport/playwright.js";
export {
  extractStructuredTextWithFallback,
  extractStructuredTextFromHtml,
  normalizeText
} from "./transport/htmlProcessing.js";
