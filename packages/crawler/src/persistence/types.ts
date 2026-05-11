import type { CrawlerExecutionMode, CrawlerPageStatus, CrawlerRunStatus } from "../core/types.js";

export type CrawlerSourceStatus = "active" | "paused" | "removed";

export type CrawlerSpeedProfile = "fast" | "balanced" | "polite";

export type CrawlerTransportMode = "http" | "browser" | "hybrid";

export type PublicationOperation = "upsert" | "delete";

export type PublicationAttemptStatus = "pending" | "delivered" | "failed" | "retryable";

export type PublicationPublisherKind = "http" | "in_process" | "radioso-crawler";

export type CrawlerSourceRecord = {
  id: string;
  scopeKey: string;
  baseUrl: string;
  displayName: string | null;
  mode: CrawlerExecutionMode;
  status: CrawlerSourceStatus;
  createdAt: string;
  updatedAt: string;
};

export type PersistedCrawlerRunRecord = {
  id: string;
  sourceId: string;
  mode: CrawlerExecutionMode;
  status: CrawlerRunStatus;
  statusReason: string | null;
  pageLimit: number;
  speedProfile: CrawlerSpeedProfile;
  transportModeRequested: CrawlerTransportMode;
  transportModeEffective: CrawlerTransportMode;
  pagesDiscovered: number;
  pagesCrawled: number;
  pagesFailed: number;
  pagesUnchanged: number;
  pagesPublished: number;
  publicationFailures: number;
  httpPagesAttempted: number;
  httpPagesAccepted: number;
  browserPagesAttempted: number;
  browserFallbackCount: number;
  runStartedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type CrawlerFrontierStatus = "queued" | "processing" | "succeeded" | "failed_terminal";

export type CrawlerFrontierRecord = {
  id: string;
  runId: string;
  url: string;
  canonicalUrl: string | null;
  status: CrawlerFrontierStatus;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  firstDiscoveredAt: string;
  lastUpdatedAt: string;
  completedAt: string | null;
};

export type CrawlerPageRecord = {
  id: string;
  sourceId: string;
  runId: string;
  frontierUrl: string;
  fetchedUrl: string;
  canonicalUrl: string;
  canonicalUrlKey: string;
  title: string | null;
  content: string;
  contentHash: string | null;
  status: CrawlerPageStatus;
  httpStatus: number | null;
  etag: string | null;
  lastModified: string | null;
  transportUsed: "http" | "browser" | null;
  browserFallbackReason: "http_error" | "incomplete_http" | "low_quality" | null;
  httpQualityScore: number | null;
  error: string | null;
  lastFetchedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicationAttemptRecord = {
  id: string;
  pageRecordId: string;
  externalId: string;
  operation: PublicationOperation;
  status: PublicationAttemptStatus;
  publisherKind: PublicationPublisherKind;
  responseDocumentId: string | null;
  responseStatus: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  attemptedAt: string;
  completedAt: string | null;
};
