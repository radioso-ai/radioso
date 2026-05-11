import type { DocumentPublisher } from "../types.js";
import type { CrawlerExecutionMode, CrawlerRunStatus, NormalizedCrawlerPage } from "./types.js";

export type CrawlerRunRecord = {
  id: string;
  sourceId: string;
  mode: CrawlerExecutionMode;
  status: CrawlerRunStatus;
  pageLimit: number;
  runStartedAt?: string | null;
  finishedAt?: string | null;
};

export type CrawlerStateStore = {
  createRun: (input: {
    sourceId: string;
    mode: CrawlerExecutionMode;
    pageLimit: number;
  }) => Promise<CrawlerRunRecord>;
  updateRun: (
    id: string,
    patch: Partial<Omit<CrawlerRunRecord, "id" | "sourceId">>
  ) => Promise<void>;
  savePage: (page: NormalizedCrawlerPage) => Promise<void>;
  recordPublicationAttempt: (input: {
    pageCanonicalUrlKey: string;
    externalId: string;
    operation: "upsert" | "delete";
    status: "pending" | "delivered" | "failed" | "retryable";
    failureMessage?: string | null;
  }) => Promise<void>;
};

export type CrawlerRuntimeDependencies = {
  stateStore: CrawlerStateStore;
  documentPublisher: DocumentPublisher;
};
