import type {
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
} from "./types.js";
import type { CrawlerExecutionMode, CrawlerPageStatus, CrawlerRunStatus } from "../core/types.js";

export type CrawlerSourcesRepository = {
  create: (input: {
    scopeKey: string;
    baseUrl: string;
    displayName?: string | null;
    mode: CrawlerExecutionMode;
    status?: CrawlerSourceStatus;
  }) => Promise<CrawlerSourceRecord>;
  getById: (id: string) => Promise<CrawlerSourceRecord | null>;
  getByScopeKey: (scopeKey: string) => Promise<CrawlerSourceRecord | null>;
  updateStatus: (input: {
    id: string;
    status: CrawlerSourceStatus;
  }) => Promise<CrawlerSourceRecord | null>;
};

export type CrawlerRunsRepository = {
  create: (input: {
    sourceId: string;
    mode: CrawlerExecutionMode;
    pageLimit: number;
    speedProfile?: CrawlerSpeedProfile;
    transportModeRequested?: CrawlerTransportMode;
    transportModeEffective?: CrawlerTransportMode;
    status?: CrawlerRunStatus;
    statusReason?: string | null;
    runStartedAt?: string | null;
    finishedAt?: string | null;
  }) => Promise<PersistedCrawlerRunRecord>;
  getById: (id: string) => Promise<PersistedCrawlerRunRecord | null>;
  listBySourceId: (sourceId: string) => Promise<PersistedCrawlerRunRecord[]>;
  update: (input: {
    id: string;
    status?: CrawlerRunStatus;
    statusReason?: string | null;
    pagesDiscovered?: number;
    pagesCrawled?: number;
    pagesFailed?: number;
    pagesUnchanged?: number;
    pagesPublished?: number;
    publicationFailures?: number;
    httpPagesAttempted?: number;
    httpPagesAccepted?: number;
    browserPagesAttempted?: number;
    browserFallbackCount?: number;
    runStartedAt?: string | null;
    finishedAt?: string | null;
    transportModeEffective?: CrawlerTransportMode;
  }) => Promise<void>;
};

export type CrawlerFrontierRepository = {
  ensureQueued: (input: {
    runId: string;
    url: string;
    canonicalUrl?: string | null;
    maxAttempts?: number;
  }) => Promise<{ created: boolean; item: CrawlerFrontierRecord }>;
  listByRunId: (runId: string) => Promise<CrawlerFrontierRecord[]>;
  markStatus: (input: {
    runId: string;
    url: string;
    status: CrawlerFrontierStatus;
    lastError?: string | null;
  }) => Promise<void>;
};

export type CrawlerPagesRepository = {
  upsert: (input: {
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
    etag?: string | null;
    lastModified?: string | null;
    transportUsed?: "http" | "browser" | null;
    browserFallbackReason?: "http_error" | "incomplete_http" | "low_quality" | null;
    httpQualityScore?: number | null;
    error?: string | null;
    lastFetchedAt?: string;
  }) => Promise<CrawlerPageRecord>;
  getByCanonicalUrlKey: (
    sourceId: string,
    canonicalUrlKey: string
  ) => Promise<CrawlerPageRecord | null>;
  listBySourceId: (sourceId: string) => Promise<CrawlerPageRecord[]>;
  listByRunId: (runId: string) => Promise<CrawlerPageRecord[]>;
};

export type CrawlerPublicationAttemptsRepository = {
  create: (input: {
    pageRecordId: string;
    externalId: string;
    operation: PublicationOperation;
    status: PublicationAttemptStatus;
    publisherKind: PublicationPublisherKind;
    responseDocumentId?: string | null;
    responseStatus?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
    completedAt?: string | null;
  }) => Promise<PublicationAttemptRecord>;
  listByPageRecordId: (pageRecordId: string) => Promise<PublicationAttemptRecord[]>;
};

export type CrawlerPersistence = {
  frontier: CrawlerFrontierRepository;
  pages: CrawlerPagesRepository;
  publicationAttempts: CrawlerPublicationAttemptsRepository;
  runs: CrawlerRunsRepository;
  sources: CrawlerSourcesRepository;
};
